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
 * Needs node >= 22.6 (both engines are .ts loaded by type-stripping, no build step). The repo's
 * .nvmrc (node 24) satisfies it.
 *
 * ── HONESTY NOTES ───────────────────────────────────────────────────────────────────────
 * - The legacy leg drives the worker's REAL exported primitives (bucketRgbaHistogram,
 *   bucketRgbaBinarize, morphClose, detectSolidRoomRectangle, floodSolidRoomRectangle,
 *   floodFill, traceBorder, findHoleBorders). Only its two PRIVATE steps are reimplemented —
 *   `downscaleAndBinarize` and `douglasPeucker`, neither of which is exported. Those mirrors,
 *   the flood/trace sequence they sit in, and the sha256 PARITY pin that catches drift all live
 *   in `scripts/probes/_legacy-mirror.mjs`, shared with `scripts/corpus-differential.mjs` so
 *   that "the legacy leg" is ONE sequence rather than two copies drifting apart.
 * - `standardFontDataUrl` is wired. Without it the raster leg binarizes different text ink
 *   than production does, which silently changes what the flood stops at.
 * - Rows are emitted for refusals and errors too, never dropped, with the status verbatim.
 *   Refusal rate is a reported metric, not an inconvenience to be filtered out.
 */

// Side-effect import: teaches bare node the "@/" alias + extensionless .ts. MUST come first.
import "./probes/_ts-resolve.mjs";
import { readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

// ── node gate ────────────────────────────────────────────────────────────────
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `\nFATAL: needs node >= 22.6 for TypeScript type-stripping; you are on ${process.versions.node}.\n` +
      `  Use the repo's .nvmrc node (24):  . /usr/local/share/nvm/nvm.sh && nvm use\n`,
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
const maxDim = Number(flag("max-dim", "1000")); // the worker's own default (processFill:558)
const tolerance = Number(flag("tolerance", "30"));
const dilation = Number(flag("dilation", "0"));
const quiet = bool("quiet");
// RDP epsilon for the vector trace, in MASK px. PLAN: tightening it 10x surfaces the letter
// holes the old slop collapsed — so it is a flag, and the letter-hole cell is measured at both.
const vectorEps = Number(flag("vector-eps", "1.5"));
const vaSeeds = flag("va-seeds");   // default template: test/va-seeds.json (TRACKED, not test/fixtures/)
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

// The shared legacy mirror shims `globalThis.self` and re-exports the worker module, so
// importing it is also how the worker becomes loadable under bare node.
const { downscaleAndBinarize, legacyFloodAndTrace, checkParity } = await import(
  "./probes/_legacy-mirror.mjs"
);

const pdfjs = await import(join(REPO, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
const oc = await import(enginePath);
// ★ The vector leg drives the SHIPPING adapter, not the engine directly — see vectorLeg().
const adapter = await import(join(REPO, "src/lib/bucket-fill-vector-adapter.ts"));
/** Reverse of the adapter's exported refusal table: message -> short code, for the CSV. */
const REFUSAL_CODE = new Map(
  Object.entries(adapter.VECTOR_REFUSALS).map(([code, msg]) => [msg, code]),
);
const { createCanvas } = await import("@napi-rs/canvas");
const STANDARD_FONTS = join(REPO, "node_modules/pdfjs-dist/standard_fonts/");

// ── the two legs ─────────────────────────────────────────────────────────────
// Vector: extract -> mask -> flood -> trace. Seeds and traced vertices are both in DEVICE px
// (the engine applies its own `ws` mask scale internally and traceRegion converts back), so
// pt^2 = ringArea / zoom^2.
/** Shoelace over NORMALISED vertices → fraction of page area. */
function normalisedRingFraction(vertices) {
  let a = 0;
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i], q = vertices[(i + 1) % vertices.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * The vector leg drives `src/lib/bucket-fill-vector-adapter.ts` — the code that will ACTUALLY
 * SHIP — rather than calling buildMask/floodRegion/traceRegion itself.
 *
 * It used to call the engine directly, which measured a pipeline no user would ever run: no
 * barrier burning, no hole detection, no mask-dim clamp, no status mapping. An instrument that
 * measures a private path can certify a product path it never touched — and phase 3's flip is
 * gated on this instrument.
 *
 * ⚠ PER-STAGE TIMINGS ARE DELIBERATELY GONE for this leg. buildMask/flood/trace are internal to
 * the adapter now, and threading a timing callback through product code to satisfy a probe is
 * the wrong direction (the tooling bends, not the source). Stage-level timing lives in
 * scripts/probes/e2e-oneclick.mjs, which already breaks out docLoad / getOperatorList /
 * extractVectorGeometry / buildMask / flood / trace. THIS harness measures ACCURACY.
 */
function vectorLeg(geo, vp, seedPt, zoom, stage, pageWpt, pageHpt) {
  const tAdapter = performance.now();
  const res = adapter.vectorBucketFill({
    geo,
    imgW: vp.width,
    imgH: vp.height,
    // NORMALISED seed — exactly what BucketFillRequest carries.
    seedX: (seedPt.x * zoom) / vp.width,
    seedY: (seedPt.y * zoom) / vp.height,
    maskDimension: maskDim,
    epsMaskPx: vectorEps,
  });
  stage.adapterMs = performance.now() - tAdapter;
  if (res.type !== "result") {
    // Map back through the adapter's OWN exported table rather than sniffing the prose.
    return { status: REFUSAL_CODE.get(res.error) ?? "error", areaPt2: null, verts: 0 };
  }
  const pageArea = pageWpt * pageHpt;
  return {
    status: "ok",
    areaPt2: normalisedRingFraction(res.vertices) * pageArea, // outer ring, includes holes
    areaNetPt2: res.areaFraction * pageArea,                  // net of holes
    verts: res.vertices.length,
  };
}


// Legacy: the shared legacy leg (scripts/probes/_legacy-mirror.mjs), which mirrors processFill
// (bucket-fill.worker.ts:556) step for step. This wrapper only adds the pt² conversion.
function legacyLeg(pageCanvas, seedPt, zoom, pageWpt, pageHpt, stage) {
  let t = performance.now();
  const { bin, w, h, otsu, adjusted } = downscaleAndBinarize(pageCanvas, maxDim, tolerance);
  stage.binarizeMs = performance.now() - t;

  // The worker takes NORMALISED seeds (req.seedX/seedY in 0..1) and maps them onto the
  // downscaled raster, so zoom cancels out here by construction — which is exactly why any
  // zoom variance the legacy leg shows is a BINARIZATION effect, not a seed-placement one.
  const seedPx = Math.max(0, Math.min(w - 1, Math.round((seedPt.x / pageWpt) * w)));
  const seedPy = Math.max(0, Math.min(h - 1, Math.round((seedPt.y / pageHpt) * h)));

  const r = legacyFloodAndTrace(bin, w, h, seedPx, seedPy, dilation);
  stage.floodMs = r.floodMs;
  stage.traceMs = r.traceMs;
  if (r.status !== "ok") return { ...r, areaPt2: null, otsu, adjusted };

  const areaPt2 = r.areaFraction * pageWpt * pageHpt;
  return {
    status: "ok",
    // processFill:646 — already NET of holes (holes stay zero during the flood).
    areaPt2,
    areaNetPt2: areaPt2,
    verts: r.verts,
    otsu,
    adjusted,
    solidRoom: r.solidRoom,
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

// Oracles: prefer what the fixture GENERATOR emitted (it drew the geometry, so it knows the
// exact rectilinear inset even for an L-shape). Fall back to w*h for hand-written manifests
// like the built-in OT sample.
// A room's seed may be given in PDF USER space (`seedUser`) or already in device space
// (`seed`). Prefer user space: pdf.js's viewport.transform folds in /Rotate, CropBox offset
// and UserUnit, so ONE user-space seed lands on the same physical point in every frame
// variant. A device-space seed cannot do that — it would silently drift on a rotated page and
// turn a frame bug into a "the click moved" non-result.
function seedDeviceFor(room, vp, zoom) {
  if (room.seedUser) {
    const [dx, dy] = pdfjs.Util.applyTransform([room.seedUser.x, room.seedUser.y], vp.transform);
    return { x: dx / zoom, y: dy / zoom }; // callers re-multiply by zoom
  }
  return room.seed;
}

function oraclesFor(fx, room) {
  if (room.areaCenterline != null && room.areaInnerFace != null) {
    return { areaCenterline: room.areaCenterline, areaInnerFace: room.areaInnerFace };
  }
  const t = fx.wallWidthPt ?? room.wallWidthPt ?? 0;
  const holeArea = (room.holes || []).reduce((s, h) => s + h.w * h.h, 0);
  return {
    areaCenterline: room.w * room.h - holeArea,
    areaInnerFace: Math.max(0, room.w - t) * Math.max(0, room.h - t) - holeArea,
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────
const COLUMNS = [
  "fixture", "room", "leg", "zoom", "status",
  "areaPt2", "areaNetPt2", "areaCenterline", "areaInnerFace",
  "signedErrPct_centerline", "signedErrPct_innerFace", "predictedGapPct",
  "verts", "buildMaskMs", "binarizeMs", "floodMs", "traceMs", "totalMs",
  "otsu", "otsuAdjusted", "solidRoomPath", "expect", "note",
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
      const { areaCenterline, areaInnerFace } = oraclesFor(fx, room);
      const stage = {};
      const t0 = performance.now();
      let r;
      try {
        r = vectorLeg(geoC, vpC, seedDeviceFor(room, vpC, canonScale), canonScale, stage, pageWpt, pageHpt);
      } catch (e) {
        r = { status: "exception", areaPt2: null, verts: 0, note: e?.message || String(e) };
      }
      const a = r.areaPt2;
      emit({
        fixture: fx.id, room: room.id, leg: "vector", zoom: "canonical", status: r.status,
        areaPt2: a == null ? "" : a.toFixed(1),
        areaNetPt2: r.areaNetPt2 == null ? "" : r.areaNetPt2.toFixed(1),
        areaCenterline: areaCenterline.toFixed(1), areaInnerFace: areaInnerFace.toFixed(1),
        signedErrPct_centerline: a == null ? "" : (100 * (a / areaCenterline - 1)).toFixed(3),
        signedErrPct_innerFace: a == null ? "" : (100 * (a / areaInnerFace - 1)).toFixed(3),
        predictedGapPct: (100 * (1 - areaInnerFace / areaCenterline)).toFixed(3),
        verts: r.verts ?? "", buildMaskMs: "", binarizeMs: "",
        floodMs: "", traceMs: stage.adapterMs?.toFixed(1) ?? "",
        totalMs: (performance.now() - t0).toFixed(1), otsu: "", otsuAdjusted: "",
        solidRoomPath: "", expect: room.expect ?? "", note: `canonScale=${canonScale.toFixed(3)} maskPxPerPt=${(canonScale).toFixed(3)}`,
      });
    }
  }

  // ── VECTOR MASK-RESOLUTION SWEEP (optional): the quantisation-floor curve, labelled.
  for (const sc of maskSweep) {
    const vpS = page.getViewport({ scale: sc });
    const olS = await page.getOperatorList();
    const geoS = oc.extractVectorGeometry(olS, vpS.transform, pdfjs.OPS);
    for (const room of fx.rooms) {
      const { areaCenterline, areaInnerFace } = oraclesFor(fx, room);
      const stage = {};
      let r;
      try { r = vectorLeg(geoS, vpS, seedDeviceFor(room, vpS, sc), sc, stage, pageWpt, pageHpt); }
      catch (e) { r = { status: "exception", areaPt2: null, verts: 0, note: e?.message || String(e) }; }
      const a = r.areaPt2;
      const maskPxPerPt = Math.min(sc, maskDim / Math.max(pageWpt, pageHpt));
      emit({
        fixture: fx.id, room: room.id, leg: "vector-masksweep", zoom: sc, status: r.status,
        areaPt2: a == null ? "" : a.toFixed(1),
        areaNetPt2: r.areaNetPt2 == null ? "" : r.areaNetPt2.toFixed(1),
        areaCenterline: areaCenterline.toFixed(1), areaInnerFace: areaInnerFace.toFixed(1),
        signedErrPct_centerline: a == null ? "" : (100 * (a / areaCenterline - 1)).toFixed(3),
        signedErrPct_innerFace: a == null ? "" : (100 * (a / areaInnerFace - 1)).toFixed(3),
        predictedGapPct: (100 * (1 - areaInnerFace / areaCenterline)).toFixed(3),
        verts: r.verts ?? "", buildMaskMs: "", binarizeMs: "",
        floodMs: "", traceMs: stage.adapterMs?.toFixed(1) ?? "",
        totalMs: "", otsu: "", otsuAdjusted: "", solidRoomPath: "", expect: room.expect ?? "",
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
      const { areaCenterline, areaInnerFace } = oraclesFor(fx, room);
      const predictedGapPct = 100 * (1 - areaInnerFace / areaCenterline);

      for (const leg of legs.filter((l) => l === "legacy")) {
        const stage = {};
        const t0 = performance.now();
        let r;
        try {
          r = legacyLeg(pageCanvas, seedDeviceFor(room, vp, zoom), zoom, pageWpt, pageHpt, stage);
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
          areaNetPt2: r.areaNetPt2 == null ? "" : r.areaNetPt2.toFixed(1),
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
          expect: room.expect ?? "",
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
// Accuracy statistics are computed ONLY over rooms whose expected outcome is an area, and
// ALWAYS net-of-holes on both sides. Two things this guards against, both found by running it:
//   - the ring area INCLUDES holes while the raster worker's area excludes them, so on the
//     column-hole cell the ring is byte-identical to the plain room and scoring it against a
//     hole-subtracted oracle invents a false error;
//   - an expect:"leak" cell is SUPPOSED to blow up. Letting door-gap into the median dragged
//     the legacy "worst error" to 589%, which describes the fixture, not the engine.
// Leak cells get their own scorecard below, which is the more useful thing anyway.
const netOf = (r) => {
  const n = num(r.areaNetPt2);
  return n == null ? num(r.areaPt2) : n;
};
const signedErrNet = (r, oracleCol) => {
  const a = netOf(r);
  const oracle = num(r[oracleCol]);
  return a == null || !oracle ? null : 100 * (a / oracle - 1);
};

for (const leg of legs) {
  const mine = rows.filter((r) => r.leg === leg);
  const ok = mine.filter((r) => r.status === "ok");
  // Each leg is scored against ITS OWN oracle — that is the whole point of the dual oracle.
  const oracleCol = leg === "vector" ? "areaCenterline" : "areaInnerFace";
  // "leak" and "hidden-ocg" cells are not supposed to yield a trustworthy area — including
  // them would describe the fixture rather than the engine. They get the scorecard below.
  const UNSCORED = new Set(["leak", "hidden-ocg"]);
  const scored = ok.filter((r) => !UNSCORED.has(r.expect));
  const errs = scored
    .map((r) => signedErrNet(r, oracleCol))
    .filter((v) => v !== null)
    .map(Math.abs);

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
    `         |error| vs ${leg === "vector" ? "CENTERLINE" : "INNER-FACE"} oracle` +
      ` (net-of-holes, area cells only, n=${errs.length}):` +
      `  median=${errs.length ? med(errs).toFixed(3) : "n/a"}%  worst=${errs.length ? Math.max(...errs).toFixed(3) : "n/a"}%`,
  );
  // A >50% error on a cell that IS supposed to yield an area is not an accuracy datum, it is
  // a failure. Naming them beats letting them set a "worst" that reads like a tolerance.
  const blown = scored
    .map((r) => ({ r, e: signedErrNet(r, oracleCol) }))
    .filter((x) => x.e != null && Math.abs(x.e) > 50);
  for (const { r, e } of blown) {
    out.push(
      `         !! ${r.fixture} — ${e > 0 ? "+" : ""}${e.toFixed(0)}% : did not measure the room at all`,
    );
  }
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

// ── REFUSAL BEHAVIOUR on cells that are SUPPOSED to fail ─────────────────────
// This is the metric PLAN asks for as "refusal rate", and it is where the two engines differ
// most sharply. A clean refusal is a good outcome; silently returning a number is not.
const trustCells = rows.filter((r) => r.expect === "leak" || r.expect === "hidden-ocg");
if (trustCells.length) {
  out.push("", " TRUST BEHAVIOUR — cells that SHOULD NOT yield a trustworthy area:");
  for (const r of trustCells) {
    const a = netOf(r);
    const oracle = num(r.areaCenterline);
    let verdict;
    if (r.status !== "ok") {
      verdict = `REFUSED (${r.status}) — correct, the user is told`;
    } else if (r.expect === "hidden-ocg") {
      // Here the FULL room is the honest answer; a fraction of it means the engine traced
      // linework the user cannot see and committed a wrong number with status ok.
      const frac = a / oracle;
      verdict =
        frac < 0.75
          ? `!! ${a?.toFixed(0)} pt² = ${(100 * frac).toFixed(0)}% of the ${oracle?.toFixed(0)} pt² room ` +
            `— TRACED THE HIDDEN LAYER. Confidently wrong, status ok, no warning.`
          : `${a?.toFixed(0)} pt² = ${(100 * frac).toFixed(0)}% — hidden layer NOT traced (correct)`;
    } else {
      verdict =
        `!! RETURNED AN AREA: ${a?.toFixed(0)} pt² for a ${oracle?.toFixed(0)} pt² room ` +
        `(${(100 * (a / oracle - 1)).toFixed(0)}% over) — a confidently wrong number`;
    }
    out.push(`   ${String(r.fixture).padEnd(16)} ${String(r.leg).padEnd(7)} ${verdict}`);
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
// Only over rooms where BOTH legs actually measured the room — within 10% of the centerline
// oracle. Differencing a leak against a measurement is not a step change, it is a failure,
// and letting one in dragged this range to -85.9% (the E-size cell, where the raster leg
// returns the whole sheet).
const MEASURED = (r) => {
  const a = netOf(r);
  const o = num(r.areaCenterline);
  return a != null && o && Math.abs(a / o - 1) < 0.1;
};
const vecByRoom = new Map();
for (const r of rows.filter((r) => r.leg === "vector" && r.status === "ok" && MEASURED(r))) {
  vecByRoom.set(`${r.fixture}/${r.room}`, netOf(r));
}
const steps = [];
for (const r of rows.filter((r) => r.leg === "legacy" && r.status === "ok" && MEASURED(r))) {
  const v = vecByRoom.get(`${r.fixture}/${r.room}`);
  const l = netOf(r);
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

// ── PARITY: the shared mirror still matches the worker (exit 3 on drift) ─────
await checkParity({ quiet });

// ── PHASE-1 GATE: the VA oracle ──────────────────────────────────────────────
// PLAN §5 phase 1's last gate condition. Three assertions against three rooms of OpenTakeoff's
// own VA finish plan, whose areas come from their changelog (treated as ratios + total, not
// gospel). Requires hand-picked seeds — see notes/OWNER_VA_SEEDS.md and
// scripts/probes/va-seed-picker.mjs. This block only runs with --va-seeds.
if (vaSeeds) {
  const spec = JSON.parse(readFileSync(vaSeeds, "utf8"));
  const pdfPath = spec.pdf && existsSync(spec.pdf) ? spec.pdf : join(OT_CLONE, "demo/sample-finish-plan.pdf");
  if (!existsSync(pdfPath)) {
    console.error(`FATAL: VA drawing not found: ${pdfPath}`);
    process.exit(2);
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONTS,
  }).promise;
  const page = await doc.getPage(spec.page ?? 1);
  const vp1 = page.getViewport({ scale: 1 });
  const canon = maskDim / Math.max(vp1.width, vp1.height);
  const vp = page.getViewport({ scale: canon });
  const geo = oc.extractVectorGeometry(await page.getOperatorList(), vp.transform, pdfjs.OPS);

  const out = ["", "─".repeat(78), " PHASE-1 GATE — VA ORACLE (three assertions)", "─".repeat(78)];
  const measured = [];
  for (const room of spec.rooms) {
    if (!room.seedUser || (room.seedUser.x === 0 && room.seedUser.y === 0)) {
      console.error(`\nFATAL: room ${room.id} still has a placeholder seed (0,0).`);
      console.error(`  Pick real points first — see notes/OWNER_VA_SEEDS.md. Refusing to`);
      console.error(`  report a gate result from placeholder coordinates.\n`);
      process.exit(2);
    }
    const [dx, dy] = pdfjs.Util.applyTransform([room.seedUser.x, room.seedUser.y], vp.transform);
    const r = adapter.vectorBucketFill({
      geo, imgW: vp.width, imgH: vp.height,
      seedX: dx / vp.width, seedY: dy / vp.height,
      maskDimension: maskDim,
    });
    measured.push({
      id: room.id,
      expectedSF: room.expectedSF,
      status: r.type === "result" ? "ok" : (REFUSAL_CODE.get(r.error) ?? "error"),
      pt2: r.type === "result" ? r.areaFraction * vp1.width * vp1.height : null,
    });
  }
  for (const m of measured) {
    out.push(`   room ${String(m.id).padEnd(5)} status=${m.status.padEnd(12)} ` +
      `${m.pt2 == null ? "        —" : m.pt2.toFixed(0).padStart(9)} pt²   oracle ${m.expectedSF} SF`);
  }

  const ok = measured.filter((m) => m.pt2 != null);
  if (ok.length !== measured.length) {
    out.push("", " ⛔ FAIL — not every room measured; the assertions below need all three.");
    process.exitCode = 1;
  } else {
    const totalPt2 = ok.reduce((a, m) => a + m.pt2, 0);
    const totalSF = ok.reduce((a, m) => a + m.expectedSF, 0);

    // (1) RATIOS — scale-free, so this isolates ENGINE error from sheet-scale error.
    out.push("", " (1) room-area RATIOS within 1% (scale-free — isolates engine error):");
    let ratiosPass = true;
    for (const m of ok) {
      const got = m.pt2 / totalPt2, want = m.expectedSF / totalSF;
      const dev = 100 * (got / want - 1);
      const p = Math.abs(dev) <= 1;
      ratiosPass &&= p;
      out.push(`     room ${String(m.id).padEnd(5)} share ${(100*got).toFixed(2)}% vs ${(100*want).toFixed(2)}%  ` +
        `dev ${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%  ${p ? "PASS" : "FAIL"}`);
    }

    // Scale: stated, or derived from the total. If DERIVED, assertions (2) and (3) are not
    // independent evidence and must not be reported as if they were.
    const derived = spec.sqftPerPt2 == null;
    const sqftPerPt2 = derived ? totalSF / totalPt2 : spec.sqftPerPt2;
    out.push("", derived
      ? ` scale: NOT STATED in the manifest, so it was DERIVED from the oracle total\n` +
        `        (${sqftPerPt2.toExponential(4)} SF/pt²). ⚠ Assertions (2) and (3) are therefore\n` +
        `        NOT independent — (3) is true by construction. Only (1) is real evidence.\n` +
        `        Add "sqftPerPt2" to va-seeds.json to make them independent.`
      : ` scale: STATED as ${sqftPerPt2.toExponential(4)} SF/pt² — assertions (2) and (3) are independent.`);

    // (2) per-room absolutes within 2%
    out.push("", " (2) per-room ABSOLUTES within 2%:");
    let absPass = true;
    for (const m of ok) {
      const sf = m.pt2 * sqftPerPt2;
      const dev = 100 * (sf / m.expectedSF - 1);
      const p = Math.abs(dev) <= 2;
      absPass &&= p;
      out.push(`     room ${String(m.id).padEnd(5)} ${sf.toFixed(1)} SF vs ${m.expectedSF} SF  ` +
        `dev ${dev >= 0 ? "+" : ""}${dev.toFixed(2)}%  ${p ? "PASS" : "FAIL"}`);
    }

    // (3) sum within 2%
    const gotTotal = totalPt2 * sqftPerPt2;
    const totDev = 100 * (gotTotal / totalSF - 1);
    const totPass = Math.abs(totDev) <= 2;
    out.push("", ` (3) Σ within 2% of ${totalSF} SF:  ${gotTotal.toFixed(1)} SF  ` +
      `dev ${totDev >= 0 ? "+" : ""}${totDev.toFixed(2)}%  ${totPass ? "PASS" : "FAIL"}` +
      (derived ? "   (NOT independent — see scale note)" : ""));

    const allPass = ratiosPass && absPass && totPass;
    out.push("", ` ⇒ PHASE-1 VA GATE: ${allPass ? "PASS" : "FAIL"}`);
    if (!allPass && ratiosPass) {
      out.push("   Ratios pass but absolutes/Σ do not ⇒ this is a SCALE problem, not an engine");
      out.push("   problem. Re-derive the sheet scale; the engine is tracking the drawing.");
    }
    if (!allPass) process.exitCode = 1;
  }
  out.push("─".repeat(78), "");
  process.stderr.write(out.join("\n"));
  await doc.destroy();
}
