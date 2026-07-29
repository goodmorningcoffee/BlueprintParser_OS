#!/usr/bin/env node

/**
 * corpus-differential.mjs — THE PHASE-3 DIFFERENTIAL, in DIRECTORY MODE.
 *
 * PLAN.md §6 / §5-phase-3: "the accuracy instrument must show the vector path is better ON REAL
 * DRAWINGS before the public default flip." Everything measured so far is synthetic — the
 * ~1.3-1.4% step change in `notes/RELEASE_LANGUAGE.md` is stroke-width arithmetic on fixtures we
 * drew ourselves. This harness points both engines at a directory of REAL PDFs and reports what
 * actually differs.
 *
 * ── WHY THIS NEEDS NO ORACLE, AND WHY THAT IS THE POINT ─────────────────────────────────
 * `scripts/oneclick-accuracy.mjs` scores each leg against a per-room ground truth, which only
 * exists on fixtures whose geometry we authored. Real drawings have no ground truth without
 * someone hand-measuring rooms, which is owner time and is the #1 open ask.
 *
 * So this harness scores the engines **against each other**. That is a strictly weaker claim —
 * it cannot say which one is RIGHT — but it is the claim phase 4's gate actually needs:
 *
 *   - where they AGREE, the flip is a no-op for that region and nothing needs saying;
 *   - where they DISAGREE, at least one is wrong, and the disagreement rate on real sheets is
 *     the number the release note has been missing;
 *   - where one REFUSES and the other returns a number, that is the RC4 thesis under test
 *     ("refuses clearly" beats "traces wrong") and it is directly reportable.
 *
 * And it is runnable unattended, which the oracle version is not.
 *
 * ── THE SEED PROPOSER MUST NOT FAVOUR EITHER ENGINE ─────────────────────────────────────
 * A differential is only as honest as its seeds. Seeding from the vector engine's own floods —
 * which is what `scripts/probes/va-seed-propose.mjs` does, correctly, for its purpose — would
 * place every click where the vector engine already succeeds, and the vector refusal rate would
 * come out near zero BY CONSTRUCTION. That is a measurement bug of exactly the kind this project
 * has already made once (the vector zoom sweep; see oneclick-accuracy.mjs's header).
 *
 * So seeds come from a NEUTRAL OCCUPANCY FIELD: a pixel is "ink" if the raster binarization says
 * so **or** if the vector mask says so. A seed is only proposed at a point BOTH engines agree is
 * empty, and it is placed at the pole of inaccessibility (the free point farthest from any ink)
 * of a connected free region — the same "click near the middle of the space" rule a user follows,
 * and the same rule `va-seed-propose.mjs` uses at step 3. Neither engine's flood is consulted.
 * Union-of-ink is the conservative choice for both: it never hands one engine a point the other
 * calls a wall.
 *
 * What the union DOES do is seal gaps that only one engine sees, which changes which free regions
 * exist. That is unavoidable — some field has to enumerate the regions — and it is symmetric: a
 * hairline the raster leg misses and a hairline the vector leg misses are treated identically.
 * The engines are then free to leak or refuse on their own, which is precisely what gets counted.
 *
 * ⚠ TWO KNOWN LIMITS OF THE PROPOSER, stated because they shape what the sample can show:
 *   1. RESOLUTION. `markVectorInk` block-ORs the 3000 px vector mask down onto the <=1000 px
 *      working grid, so a 1-mask-px hairline blackens a whole grid cell. The field is therefore
 *      MORE sealed than either engine's own view, and regions that only exist because a gap was
 *      closed at grid resolution get seeded as if enclosed. This inflates neither engine's score
 *      — both are asked the same question — but it means "the engines agree" is a statement about
 *      regions the FIELD found, not about every space on the sheet.
 *   2. HATCH. Soft hatch (mask bit 2) counts as ink here, because a point sitting on a hatch
 *      stroke is not a point the raster leg calls empty. The consequence is that densely hatched
 *      interiors — where the two engines diverge MOST, since vector can escalate through hatch and
 *      raster cannot — are under-seeded, and a fully hatched room may produce no seed at all. The
 *      differential is therefore CONSERVATIVE about hatch: it under-reports the disagreement that
 *      matters most. Do not read a high agreement rate as covering hatched space.
 *
 * ── WHAT IS SAMPLED, AND WHAT IS NOT ────────────────────────────────────────────────────
 * CANON rule 7: the scope is ANY enclosed pixel space, not rooms. Nothing here tests aspect
 * ratio, rectilinearity, or label containment, and there is no room-shaped floor. Two limits do
 * apply and both are SAMPLING BUDGET, not engine policy — the summary prints how many regions
 * each one dropped so the budget can never be mistaken for a finding:
 *   --min-cells   (default 25)  regions smaller than this in the neutral grid are not seeded.
 *                               At a 1000-px grid that is ~0.0025% of the sheet. Purely a cap on
 *                               how many thousands of specks get clicked.
 *   LEAK_FRACTION (0.30)        regions larger than 30% of the sheet are not seeded: the engine's
 *                               own constant for "not an enclosed space". These are the page
 *                               margin and the outside-the-building void; seeding them measures
 *                               the sheet, not the engines.
 *   --seeds-per-page (default 12) when a page has more eligible regions than this, the sample is
 *                               taken round-robin across LOG-AREA strata, so it spans magnitudes.
 *                               ⚠ It used to take an even stride through the size-ordered list.
 *                               That looked right and was wrong: region sizes are power-law, so
 *                               ranks 1..N are almost all tail — measured on single_page p1, five
 *                               of the first six seeds landed on 25-to-150-cell specks. Results
 *                               are also broken out per stratum, because "the engines agree" over
 *                               a sample that is 80% specks is not a statement about rooms.
 *
 * ── METRICS ─────────────────────────────────────────────────────────────────────────────
 *   areaFraction   both engines report net-of-holes area as a fraction of the page. Directly
 *                  comparable, no scale, no units — CANON: this arc is unitless.
 *   IoU            area agreement alone is weak: two engines can return the same area for
 *                  different regions. The vector polygon (outer ring minus holes) is rasterised
 *                  onto the legacy leg's own grid with the PRODUCT's `fillPolygonOnBinary`, and
 *                  intersection-over-union is reported. IoU is the honest agreement number.
 *   status         every refusal is a row, never a dropped one, with the adapter's own short
 *                  code (via its exported VECTOR_REFUSALS table — never string-sniffed).
 *   implausible    areaFraction > LEAK_FRACTION with status ok = a confidently wrong number.
 *                  ⚠ Only the LEGACY count is a measurement. `floodRegion` caps the vector fill
 *                  at LEAK_FRACTION and returns status `leak` beyond it (oneclick.ts:576,607), so
 *                  "vector confidently wrong = 0" is true by construction and is NOT evidence.
 *                  The measurable form of RC4 is: on the clicks where legacy silently returned a
 *                  sheet-sized area, did vector refuse? That is what the summary reports.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────────────────
 *   node scripts/corpus-differential.mjs --dir /path/to/pdfs [--out results.csv]
 *        [--seeds-per-page 12] [--min-cells 25] [--from-page 1] [--max-pages N] [--pdf substr]
 *        [--mask-dim 3000] [--max-dim 1000] [--tolerance 30] [--dilation 0]
 *        [--render-long-side 2000 | --render-scale 2.0] [--page-budget-ms 180000]
 *        [--resume] [--render DIR] [--summary-json path.json] [--quiet]
 *
 * For a full-corpus run, add --expose-gc (node allocates the page canvases natively, so V8 feels
 * no pressure and defers collection; a measured 24-page run ramped 509 MB -> 3.8 GB before the
 * first major GC):
 *   node --expose-gc scripts/corpus-differential.mjs --dir DIR --out results.csv --resume
 *
 * ⚠ NO IN-PROCESS WATCHDOG. `--page-budget-ms` is checked BETWEEN seeds, so it bounds the click
 * loop but not a pdf.js parse or render that hangs on a malformed page. Wrap an unattended run in
 * `timeout` if that matters.
 *
 * ── NODE ────────────────────────────────────────────────────────────────────────────────
 * Needs node >= 22.6 (type-stripping loads the .ts engine and worker directly). The test suite's
 * .nvmrc pins node 20; this is the opposite requirement and they do not conflict.
 */

// Side-effect import: teaches bare node the "@/" alias + extensionless .ts. MUST come first.
import "./probes/_ts-resolve.mjs";
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, basename, resolve } from "node:path";

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
/**
 * A numeric flag that refuses to be NaN.
 *
 * `--max-pages abc` used to become NaN, compare false against every page number, measure zero
 * pages, write a header-only CSV and exit 0 — an unattended run that looks like a clean result
 * and contains nothing. A typo must be loud.
 */
const numFlag = (n, d) => {
  const raw = flag(n, null);
  if (raw === null) return d;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    console.error(`FATAL: --${n} expects a number, got "${raw}".`);
    process.exit(2);
  }
  return v;
};

const dirArg = flag("dir");
if (!dirArg) {
  console.error("FATAL: --dir <directory of PDFs> is required.");
  process.exit(2);
}
const DIR = resolve(dirArg);
if (!existsSync(DIR)) {
  console.error(`FATAL: --dir does not exist: ${DIR}`);
  process.exit(2);
}

const outArg = flag("out");
const summaryJson = flag("summary-json");
const renderDir = flag("render");
const seedsPerPage = numFlag("seeds-per-page", 12);
const minCells = numFlag("min-cells", 25);
const maxPages = numFlag("max-pages", Infinity);
/** First page to measure, 1-based. Exists so a single suspect page can be reproduced directly. */
const fromPage = numFlag("from-page", 1);
const pdfFilter = flag("pdf");
const maskDim = numFlag("mask-dim", 3000);
const maxDim = numFlag("max-dim", 1000); // the worker's own default (processFill:558)
const tolerance = numFlag("tolerance", 30);
const dilation = numFlag("dilation", 0);
/**
 * The legacy render, sized by LONG SIDE rather than by a fixed scale factor.
 *
 * A fixed `--render-scale 2` renders a 2592 pt sheet at 5184 px and a 3024 pt E-size sheet at
 * 6048 px, and `downscaleAndBinarize` then takes BOTH to a 1000 px working grid. Different
 * downscale ratios mean different antialiasing, which means a different Otsu threshold — a
 * sheet-size confound sitting inside the legacy leg that has nothing to do with either engine.
 * Sizing by long side gives every sheet the same 2x supersample of the same working grid, and
 * caps the peak canvas at ~16 MB instead of ~104 MB on E-size.
 * `--render-scale` remains as an explicit override for anyone who wants the old behaviour.
 */
const renderLongSide = numFlag("render-long-side", 2000);
const renderScaleOverride = flag("render-scale") == null ? null : numFlag("render-scale", 2);
const pageBudgetMs = numFlag("page-budget-ms", 180000);
const resume = bool("resume");
const quiet = bool("quiet");
/** Agreement band: |ΔareaFraction| within this % counts as "the flip is a no-op here". */
const AGREE_PCT = numFlag("agree-pct", 5);
/** IoU at or above this counts as "the same region". */
const IOU_SAME = numFlag("iou-same", 0.9);
/**
 * How many times its own neutral-field region an engine may return before it counts as having
 * ESCAPED the space that was clicked. 1.0 would be the ideal; the field is the union of both
 * engines' ink and so excludes wall thickness a centreline flood legitimately covers, which puts
 * honest answers a little above 1. 3 is comfortably clear of that and far below a real leak
 * (measured: 4.8x for a whole-outside flood, 100x+ for a speck that escaped into a table).
 */
const ESCAPE_X = numFlag("escape-x", 3);
/**
 * Overlays written per page, most-divergent first (lowest IoU, then largest |Δ|).
 * Unbounded, this allocated a full-size native canvas per disagreement and SIGKILLed the run.
 */
const renderMaxPerPage = numFlag("render-max-per-page", 3);
let overlaysSkipped = 0;

// ── product code under test ──────────────────────────────────────────────────
import { REPO, enginePath, loadPdfjs } from "./probes/_paths.mjs";
const { downscaleAndBinarize, legacyPrep, legacyFloodAndTrace, checkParity } = await import(
  "./probes/_legacy-mirror.mjs"
);
const pdfjs = await loadPdfjs();
const oc = await import(enginePath());
/**
 * ★ The vector leg drives `bucket-fill-vector-adapter.ts` — as `oneclick-accuracy.mjs` does.
 *
 * ⚠ AND THAT IS NOT LITERALLY THE SHIPPING CALL PATH. Measured 2026-07-29: `vectorBucketFill` has
 * **no production caller** (`grep -rn "vectorBucketFill(" src/` outside tests returns only its own
 * definition). What ships is worker #2 — `src/lib/oneclick-worker-core.ts`, driven through
 * `bucket-fill-vector-client.ts` — which reimplements the same sequence with the mask CACHED PER
 * PAGE (`handleMask`) and the flood run per click (`handleFill`).
 *
 * For ACCURACY the two are equivalent, and that was checked line by line rather than assumed:
 * same `buildMask`, same `floodRegion` at `SENS_BALANCED`, same `snapVertices(traceRegion(...),
 * NO_SNAP, 7)`, same `findHoleBorders` bounded by the same bbox, same `isHoleSignificant` filter,
 * same normalisation. Every area and every polygon in this CSV is what worker #2 would return.
 *
 * For TIMING they are NOT equivalent, and `vecMs` is labelled accordingly: this harness rebuilds
 * the mask on every click, so `vecMs` is a COLD click. Production pays that once per page and
 * serves warm clicks from the cache. Do not read `vecMs` as the per-click cost users experience.
 */
const adapter = await import(join(REPO, "src/lib/bucket-fill-vector-adapter.ts"));
const maskOps = await import(join(REPO, "src/lib/bucket-fill-mask-ops.ts"));
/** Reverse of the adapter's exported refusal table: message -> short code. Never sniff prose. */
const REFUSAL_CODE = new Map(
  Object.entries(adapter.VECTOR_REFUSALS).map(([code, msg]) => [msg, code]),
);
const { createCanvas } = await import("@napi-rs/canvas");
const STANDARD_FONTS = join(REPO, "node_modules/pdfjs-dist/standard_fonts/");
/** The engine's own "this is not an enclosed space" constant. Imported, never re-typed. */
const LEAK_FRACTION = oc.LEAK_FRACTION;

// ── the neutral occupancy field ──────────────────────────────────────────────
/**
 * Mark vector ink onto the legacy leg's grid.
 *
 * The vector mask lives at mask resolution (up to 3000 px on the long side); the legacy grid is
 * the worker's downscaled raster (<= --max-dim). Every non-zero mask pixel — wall bit OR hatch
 * bit — marks its containing grid cell. Hatch counts as ink here on purpose: the neutral field's
 * job is to find points that are unambiguously empty, and a point sitting on a hatch stroke is
 * not one.
 */
function markVectorInk(occ, gw, gh, mask, mw, mh) {
  const sx = gw / mw, sy = gh / mh;
  for (let my = 0; my < mh; my++) {
    const row = my * mw;
    const gy = Math.min(gh - 1, (my * sy) | 0);
    const grow = gy * gw;
    for (let mx = 0; mx < mw; mx++) {
      if (mask[row + mx] === 0) continue;
      occ[grow + Math.min(gw - 1, (mx * sx) | 0)] = 1;
    }
  }
}

/**
 * Exact Chebyshev distance transform of the FREE space, two passes.
 *
 * The page border is treated as occupied so a seed never lands hard against the sheet edge —
 * a click there is not a click a user makes, and both engines behave oddly at the boundary.
 */
function distanceTransform(occ, w, h) {
  const INF = 0x3fffffff;
  const d = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      d[i] = occ[i] ? 0 : INF;
    }
  }
  // forward: up-left, up, up-right, left  (+ the implicit occupied border)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = y === 0 || x === 0 || x === w - 1 ? 0 : INF;
      if (y > 0) {
        if (x > 0) m = Math.min(m, d[i - w - 1]);
        m = Math.min(m, d[i - w]);
        if (x < w - 1) m = Math.min(m, d[i - w + 1]);
      }
      if (x > 0) m = Math.min(m, d[i - 1]);
      d[i] = Math.min(d[i], m + 1);
    }
  }
  // backward: down-right, down, down-left, right
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = y === h - 1 || x === 0 || x === w - 1 ? 0 : INF;
      if (y < h - 1) {
        if (x < w - 1) m = Math.min(m, d[i + w + 1]);
        m = Math.min(m, d[i + w]);
        if (x > 0) m = Math.min(m, d[i + w - 1]);
      }
      if (x < w - 1) m = Math.min(m, d[i + 1]);
      d[i] = Math.min(d[i], m + 1);
    }
  }
  return d;
}

/**
 * Connected components of the free space (4-connectivity, matching the worker's scanline flood),
 * each reduced to its pole of inaccessibility.
 *
 * Deterministic throughout: components are discovered in raster order and ties on the distance
 * maximum resolve to the lowest index, so the same PDF always yields the same seeds.
 */
function freeRegions(occ, dt, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  for (let start = 0; start < occ.length; start++) {
    if (occ[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let count = 0, bestD = -1, bestI = start;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      count++;
      if (dt[i] > bestD) { bestD = dt[i]; bestI = i; }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && !occ[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && !occ[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && !occ[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
      if (y < h - 1 && !occ[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
    }
    out.push({
      count,
      seedX: bestI % w,
      seedY: (bestI / w) | 0,
      clearance: bestD,
      bbox: { minX, minY, maxX, maxY },
    });
  }
  return out;
}

/** Rasterise the vector result (outer ring minus significant holes) onto the legacy grid. */
function rasterizeVector(res, w, h) {
  const buf = new Uint8Array(w * h);
  maskOps.fillPolygonOnBinary(buf, w, h, res.vertices, 1);
  for (const hole of res.holes ?? []) {
    if ((hole.vertices?.length ?? 0) >= 3) maskOps.fillPolygonOnBinary(buf, w, h, hole.vertices, 0);
  }
  return buf;
}

function iou(a, b) {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ? 1 : 0, y = b[i] ? 1 : 0;
    if (x & y) inter++;
    if (x | y) uni++;
  }
  return uni === 0 ? null : inter / uni;
}

// ── the verdict taxonomy ─────────────────────────────────────────────────────
/**
 * One label per click, chosen so that every label answers a question the owner actually has.
 *
 * `*-implausible` means status ok with an area over the engine's own LEAK_FRACTION: the fill
 * escaped and the engine said nothing. That is the failure mode this port exists to remove
 * (RC4), so it outranks any area comparison — comparing two numbers when one of them is "the
 * whole sheet" describes the sheet, not the engines.
 *
 * `agree-area-differ-region` is deliberately separate from `agree`. Two engines can return the
 * same area for different places; calling that agreement is how a differential lies.
 */
function classify(vecStatus, legStatus, vFrac, lFrac, deltaPct, iouVal) {
  const vOk = vecStatus === "ok", lOk = legStatus === "ok";
  const vImp = vOk && vFrac != null && vFrac > LEAK_FRACTION;
  const lImp = lOk && lFrac != null && lFrac > LEAK_FRACTION;
  if (vOk && lOk) {
    if (vImp && lImp) return "both-implausible";
    if (vImp) return "vector-implausible";
    if (lImp) return "legacy-implausible";
    if (iouVal != null && iouVal >= IOU_SAME) return "agree-same-region";
    if (deltaPct != null && Math.abs(deltaPct) <= AGREE_PCT) return "agree-area-differ-region";
    return "disagree";
  }
  if (!vOk && lOk) return lImp ? "vector-refused-legacy-leaked" : "vector-refused-only";
  if (vOk && !lOk) return vImp ? "legacy-failed-vector-leaked" : "legacy-failed-only";
  return "both-failed";
}

/** Which verdicts are worth a picture. Agreement needs no picture; disagreement always does. */
const RENDER_VERDICTS = new Set([
  "disagree", "agree-area-differ-region", "vector-implausible", "legacy-implausible",
  "vector-refused-legacy-leaked", "legacy-failed-vector-leaked", "both-implausible",
]);

// ── CSV ──────────────────────────────────────────────────────────────────────
const COLUMNS = [
  "pdf", "page", "seedIdx", "seedX", "seedY", "clearancePx", "regionCells", "regionFrac", "sizeLog2",
  "pageWpt", "pageHpt", "segCount", "softSegs", "imageFrac", "gridW", "gridH", "otsu", "filterSafe",
  "vecStatus", "vecAreaFrac", "vecVerts", "vecHoles", "vecMs",
  "legStatus", "legAreaFrac", "legVerts", "legMs", "legSolidRoom",
  "deltaPct", "iou", "vecEscapeX", "legEscapeX", "verdict", "note",
];
const cell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/**
 * RFC-4180 field splitter. `emit` quotes any field containing a comma, quote or newline, so
 * `line.split(",")` on the way back is not a shortcut — it is a corruption. The `note` column
 * routinely contains commas (a pdf.js error message, `", none eligible"`), and reading those back
 * naively shifts every field after it and can invent a phantom row key.
 */
function parseCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return inQ ? null : out; // an unterminated quote means the line was torn mid-write
}

const rows = [];
const done = new Set(); // "pdf|page" CONFIRMED COMPLETE, for --resume
/**
 * ── THE COMPLETION SIDECAR, and why the CSV cannot be its own resume ledger ──────────────
 * Rows are per SEED; completion is per PAGE. Keying `done` off "this page has at least one row"
 * marks a page finished the moment its first seed lands, so a run killed mid-page resumes by
 * SKIPPING that page forever — its remaining seeds silently absent from both the CSV and the
 * summary, with nothing to indicate a gap. A torn final line makes it worse, because the partial
 * row stays in the file for good.
 *
 * So completion is recorded separately, AFTER a page's rows are flushed. On resume the sidecar is
 * the authority: any CSV row belonging to a page that never got its sidecar line is DISCARDED and
 * the page is re-measured. That makes a kill at any instant recoverable, including mid-write.
 */
const donePath = outArg ? outArg + ".done" : null;
const paramStamp = JSON.stringify({
  seedsPerPage, minCells, maskDim, maxDim, tolerance, dilation,
  renderLongSide, renderScaleOverride, agreePct: AGREE_PCT, iouSame: IOU_SAME, escapeX: ESCAPE_X,
});
if (outArg && resume && existsSync(outArg) && existsSync(donePath)) {
  const sidecar = readFileSync(donePath, "utf8").split("\n").filter(Boolean);
  const stampLine = sidecar.find((l) => l.startsWith("#params"));
  const priorStamp = stampLine ? stampLine.slice(8) : null;
  if (priorStamp && priorStamp !== paramStamp) {
    console.error(
      "FATAL: --resume against a run with DIFFERENT parameters. Mixing them would produce a\n" +
        "  CSV whose rows were measured under two settings with nothing to tell them apart.\n" +
        `  prior: ${priorStamp}\n  now  : ${paramStamp}\n  Use a fresh --out, or drop --resume.`,
    );
    process.exit(2);
  }
  for (const l of sidecar) {
    if (l.startsWith("#")) continue;
    const [p, pg] = l.split("\t");
    done.add(`${p}|${pg}`);
  }
  // Prior rows are replayed so the summary covers the whole corpus, not just this invocation —
  // but ONLY rows whose page is confirmed complete. Torn or orphaned rows are dropped here.
  let dropped = 0;
  for (const line of readFileSync(outArg, "utf8").split("\n").slice(1)) {
    if (!line) continue;
    const parts = parseCsvLine(line);
    if (!parts || parts.length !== COLUMNS.length) { dropped++; continue; }
    const o = {};
    COLUMNS.forEach((c, i) => (o[c] = parts[i]));
    if (!done.has(`${o.pdf}|${o.page}`)) { dropped++; continue; }
    rows.push(o);
  }
  if (!quiet) {
    console.error(
      `[differential] --resume: ${done.size} page(s) complete, ${rows.length} row(s) replayed` +
        (dropped ? `, ${dropped} incomplete/torn row(s) discarded (their pages will re-run)` : ""),
    );
  }
  // ⚠ REWRITE, don't just skip. Discarding orphan rows from `rows` fixes THIS run's summary but
  // leaves them in the FILE — and the page that owns them is about to be re-measured and marked
  // complete. A later --resume would then accept both copies and silently double-count that page.
  // Found by reasoning through a second resume after the first one; the sidecar is the authority,
  // so the file is made to match it.
  if (dropped) {
    try {
      writeFileSync(outArg, COLUMNS.join(",") + "\n" +
        rows.map((o) => COLUMNS.map((c) => cell(o[c])).join(",")).join("\n") + "\n");
      console.error(`[differential] --resume: rewrote ${outArg} without the ${dropped} orphan row(s)`);
    } catch (e) {
      console.error(
        `FATAL: could not rewrite ${outArg} to drop orphan rows (${e?.message ?? e}).\n` +
          "  Continuing would leave duplicates for any re-measured page. Refusing.",
      );
      process.exit(2);
    }
  }
} else if (outArg) {
  writeFileSync(outArg, COLUMNS.join(",") + "\n");
  writeFileSync(donePath, `#params ${paramStamp}\n`);
}

/**
 * Emit is best-effort on the WRITE and always succeeds in MEMORY. A single FUSE hiccup used to
 * kill the whole run — and worse, the page-level catch handler itself calls `emit`, so a throw
 * there escaped the handler and took the process down mid-corpus.
 */
let writeFailures = 0;
const emit = (o) => {
  rows.push(o);
  const line = COLUMNS.map((c) => cell(o[c])).join(",") + "\n";
  try {
    if (outArg) appendFileSync(outArg, line);
    else process.stdout.write(line);
  } catch (e) {
    if (writeFailures++ === 0) {
      process.stderr.write(`\n!! CSV write failed (${e?.message ?? e}) — continuing in memory.\n`);
    }
  }
};
const markPageDone = (id, pageNo, n) => {
  if (!donePath) return;
  try { appendFileSync(donePath, `${id}\t${pageNo}\t${n}\n`); }
  catch (e) { process.stderr.write(`\n!! sidecar write failed (${e?.message ?? e})\n`); }
};
if (!outArg) process.stdout.write(COLUMNS.join(",") + "\n");

if (renderDir) mkdirSync(renderDir, { recursive: true });

// ── discovery ────────────────────────────────────────────────────────────────
const pdfs = readdirSync(DIR)
  .filter((f) => f.toLowerCase().endsWith(".pdf"))
  .filter((f) => !pdfFilter || f.includes(pdfFilter))
  .sort();
if (!pdfs.length) {
  console.error(`FATAL: no PDFs in ${DIR}${pdfFilter ? ` matching "${pdfFilter}"` : ""}`);
  process.exit(2);
}
if (!quiet) console.error(`[differential] ${pdfs.length} PDF(s) in ${DIR}`);

// ── PARITY FIRST. It used to run after the whole corpus, which meant a multi-hour unattended run
// could complete and only then announce that every legacy number in it was untrustworthy.
if (!(await checkParity({ quiet }))) {
  console.error(
    "FATAL: the legacy mirror no longer matches the worker (see above). Refusing to spend a\n" +
      "  corpus run producing legacy numbers that are already known to be suspect.",
  );
  process.exit(3);
}

/** Regions dropped by the two sampling budgets — printed so a budget is never read as a finding. */
const dropped = { tooSmall: 0, tooLarge: 0, overBudget: 0 };
let pagesDone = 0, pagesSkipped = 0, warnedScratch = false;

for (const file of pdfs) {
  const id = basename(file, ".pdf");
  const path = join(DIR, file);
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(path)),
      isEvalSupported: false,
      standardFontDataUrl: STANDARD_FONTS,
    }).promise;
  } catch (e) {
    console.error(`[differential] ${id}: could not open (${e?.message ?? e}) — skipped`);
    continue;
  }
  const nPages = Math.min(doc.numPages, fromPage - 1 + maxPages);
  if (!quiet) console.error(`[differential] ${id}: ${doc.numPages} page(s), running ${nPages}`);

  for (let pageNo = fromPage; pageNo <= nPages; pageNo++) {
    if (done.has(`${id}|${pageNo}`)) { pagesSkipped++; continue; }
    const tPage = performance.now();
    let page = null;
    try {
      page = await doc.getPage(pageNo);
      const vp1 = page.getViewport({ scale: 1 });
      const pageWpt = vp1.width, pageHpt = vp1.height;

      // ── vector side: canonical scale, exactly as the product does ────────
      const canonScale = maskDim / Math.max(pageWpt, pageHpt);
      const vp = page.getViewport({ scale: canonScale });
      const geo = oc.extractVectorGeometry(await page.getOperatorList(), vp.transform, pdfjs.OPS);
      const segCount = geo.segs.length / 4;
      const imageFrac = geo.imageArea / Math.max(1, vp.width * vp.height);

      // ── legacy side: render once, binarize once, reuse for every seed ────
      const renderScale = renderScaleOverride ?? renderLongSide / Math.max(pageWpt, pageHpt);
      const rvp = page.getViewport({ scale: renderScale });
      const pageCanvas = createCanvas(Math.ceil(rvp.width), Math.ceil(rvp.height));
      const rctx = pageCanvas.getContext("2d");
      rctx.fillStyle = "#fff";
      rctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      await page.render({ canvasContext: rctx, viewport: rvp }).promise;
      const { bin, w: gw, h: gh, otsu, filterSafe } = downscaleAndBinarize(pageCanvas, maxDim, tolerance);
      const prep = legacyPrep(bin, gw, gh, dilation);

      // ── the neutral occupancy field ──────────────────────────────────────
      const occ = new Uint8Array(gw * gh);
      for (let i = 0; i < occ.length; i++) if (bin[i] === 0) occ[i] = 1;
      let softSegs = 0;
      if (segCount > 0) {
        const m = oc.buildMask(geo.segs, vp.width, vp.height, maskDim, geo.meta);
        softSegs = m.softCount;
        markVectorInk(occ, gw, gh, m.mask, m.mw, m.mh);
      }

      const dt = distanceTransform(occ, gw, gh);
      const all = freeRegions(occ, dt, gw, gh);
      const cells = gw * gh;
      const eligible = [];
      for (const r of all) {
        if (r.count < minCells) { dropped.tooSmall++; continue; }
        if (r.count / cells > LEAK_FRACTION) { dropped.tooLarge++; continue; }
        eligible.push(r);
      }
      eligible.sort((a, b) => b.count - a.count || a.seedY - b.seedY || a.seedX - b.seedX);

      // ── the sample: round-robin across LOG-AREA strata ────────────────────
      // An even stride through the size-ordered list looked right and was wrong: region sizes on
      // a real sheet are power-law, so ranks 1..N are almost entirely tail, and 5 of the first 6
      // seeds landed on 25-to-150-cell specks. Measured on single_page p1 before this was fixed.
      // Bucketing by floor(log2(cells)) and taking the largest survivor from each bucket in turn
      // spans the magnitudes instead of the ranks: the biggest space on the sheet, then something
      // an order of magnitude smaller, and so on, before any bucket gets a second seed.
      const strata = new Map();
      for (const r of eligible) {
        const b = Math.floor(Math.log2(r.count));
        if (!strata.has(b)) strata.set(b, []);
        strata.get(b).push(r);
      }
      const orderedStrata = [...strata.entries()].sort((a, b) => b[0] - a[0]).map(([, v]) => v);
      const picked = [];
      for (let round = 0; picked.length < Math.min(seedsPerPage, eligible.length); round++) {
        let took = 0;
        for (const s of orderedStrata) {
          if (picked.length >= seedsPerPage) break;
          if (round < s.length) { picked.push(s[round]); took++; }
        }
        if (!took) break;
      }
      dropped.overBudget += Math.max(0, eligible.length - picked.length);

      if (!picked.length) {
        emit({
          pdf: id, page: pageNo, seedIdx: "", seedX: "", seedY: "", clearancePx: "",
          regionCells: "", regionFrac: "", sizeLog2: "", pageWpt: pageWpt.toFixed(1), pageHpt: pageHpt.toFixed(1),
          segCount, softSegs, imageFrac: imageFrac.toFixed(4), gridW: gw, gridH: gh, otsu, filterSafe,
          vecStatus: "", vecAreaFrac: "", vecVerts: "", vecHoles: "", vecMs: "",
          legStatus: "", legAreaFrac: "", legVerts: "", legMs: "", legSolidRoom: "",
          deltaPct: "", iou: "", vecEscapeX: "", legEscapeX: "", verdict: "no-seedable-region",
          note: `${all.length} free region(s), none eligible`,
        });
      }

      const renderable = [];
      for (let s = 0; s < picked.length; s++) {
        if (performance.now() - tPage > pageBudgetMs) {
          emit({
            pdf: id, page: pageNo, seedIdx: s, seedX: "", seedY: "", clearancePx: "",
            regionCells: "", regionFrac: "", sizeLog2: "", pageWpt: pageWpt.toFixed(1), pageHpt: pageHpt.toFixed(1),
            segCount, softSegs, imageFrac: imageFrac.toFixed(4), gridW: gw, gridH: gh, otsu, filterSafe,
            vecStatus: "", vecAreaFrac: "", vecVerts: "", vecHoles: "", vecMs: "",
            legStatus: "", legAreaFrac: "", legVerts: "", legMs: "", legSolidRoom: "",
            deltaPct: "", iou: "", vecEscapeX: "", legEscapeX: "", verdict: "page-budget-exceeded",
            note: `stopped after ${s}/${picked.length} seeds at ${(performance.now() - tPage).toFixed(0)} ms`,
          });
          break;
        }
        const reg = picked[s];
        // ── the seed, and the half-pixel that used to throw it into the next cell ──────────
        // Both engines get this ONE normalised pair. The legacy leg then maps it back with the
        // worker's own `Math.round(seedX * w)` (bucket-fill.worker.ts:563).
        //
        // ⛔ The obvious `(cell + 0.5) / gw` — the true cell centre — is WRONG here, and measured
        // wrong: `Math.round` rounds a half UP, so 988 of 1000 cells came back as `cell + 1`.
        // The legacy leg was therefore flooding from the DIAGONAL NEIGHBOUR of the only cell the
        // neutral field certifies as empty, while the vector leg landed inside it. On the
        // clearance-1 and clearance-2 regions this sampler deliberately includes, that neighbour
        // is often ink — which manufactures `legacy-failed-only` rows and IoU≈0 `disagree` rows
        // out of a rounding rule, concentrated in exactly the small strata the report breaks out.
        // `+0.499` maps to `cell` for every cell (verified 0/1000 failures) and is still the cell
        // centre to within a thousandth of a pixel for the vector leg.
        const nx = (reg.seedX + 0.499) / gw;
        const ny = (reg.seedY + 0.499) / gh;

        // vector leg — the adapter, one call per click. NOTE this rebuilds the mask each time,
        // which production does NOT (worker #2 caches it per page); see the import comment.
        const tv = performance.now();
        let vres;
        try {
          vres = adapter.vectorBucketFill({
            geo, imgW: vp.width, imgH: vp.height,
            seedX: nx, seedY: ny,
            maskDimension: maskDim,
          });
        } catch (e) {
          vres = { type: "error", error: null, code: "exception", _msg: e?.message ?? String(e) };
        }
        const vecMs = performance.now() - tv;
        const vecStatus =
          vres.type === "result" ? "ok" : (vres.code ?? REFUSAL_CODE.get(vres.error) ?? "error");

        // legacy leg — the shared mirror of processFill, from the same normalised seed
        const tl = performance.now();
        const legSeedPx = Math.max(0, Math.min(gw - 1, Math.round(nx * gw)));
        const legSeedPy = Math.max(0, Math.min(gh - 1, Math.round(ny * gh)));
        let lres;
        try {
          lres = legacyFloodAndTrace(bin, gw, gh, legSeedPx, legSeedPy, dilation, prep);
        } catch (e) {
          lres = { status: "exception", areaFraction: null, verts: 0, _msg: e?.message ?? String(e) };
        }
        const legMs = performance.now() - tl;

        const vFrac = vres.type === "result" ? vres.areaFraction : null;
        const lFrac = lres.status === "ok" ? lres.areaFraction : null;
        const deltaPct = vFrac != null && lFrac ? 100 * (vFrac / lFrac - 1) : null;

        // ── IoU: do the two engines describe the SAME REGION, not merely the same area? ──
        // The vector polygon is rasterised onto the legacy leg's own grid with the PRODUCT's
        // `fillPolygonOnBinary`, so no third polygon rasteriser enters the measurement.
        let vBuf = null;
        let iouVal = null;
        if (vres.type === "result" && lres.status === "ok") {
          vBuf = rasterizeVector(vres, gw, gh);
          iouVal = iou(vBuf, lres.filled);
        }

        // ── ESCAPE RATIO: an oracle-free leak detector, and a better one than a fixed 30% ──
        // The neutral field already decided how big the space around this seed is. An engine that
        // stays inside it returns roughly that area; an engine that escapes returns a multiple of
        // it. Measured on corpus-project p3, legacy returned 0.1743 of the sheet from a 36,639-cell seed
        // region — the same 0.1743 it returns when seeded in the page margin, i.e. it flooded the
        // whole outside. LEAK_FRACTION never caught it, because on that sheet the outside is only
        // 17% of the page. The escape ratio catches it at 4.8x.
        // ⚠ A ratio slightly above 1 is EXPECTED and is not an escape: the neutral field is the
        // union of both engines' ink, so it excludes wall thickness that a centreline flood
        // legitimately covers.
        const regionFracVal = reg.count / cells;
        const vecEscapeX = vFrac != null && regionFracVal > 0 ? vFrac / regionFracVal : null;
        const legEscapeX = lFrac != null && regionFracVal > 0 ? lFrac / regionFracVal : null;

        const verdict = classify(vecStatus, lres.status, vFrac, lFrac, deltaPct, iouVal);
        if (renderDir && RENDER_VERDICTS.has(verdict)) {
          renderable.push({ seedIdx: s, nx, ny, verdict, vres, lres, iouVal, deltaPct, reg });
        }

        emit({
          pdf: id, page: pageNo, seedIdx: s,
          seedX: nx.toFixed(5), seedY: ny.toFixed(5),
          clearancePx: reg.clearance, regionCells: reg.count,
          regionFrac: (reg.count / cells).toFixed(5),
          sizeLog2: Math.floor(Math.log2(reg.count)),
          pageWpt: pageWpt.toFixed(1), pageHpt: pageHpt.toFixed(1),
          segCount, softSegs, imageFrac: imageFrac.toFixed(4),
          gridW: gw, gridH: gh, otsu, filterSafe,
          vecStatus, vecAreaFrac: vFrac == null ? "" : vFrac.toFixed(6),
          vecVerts: vres.type === "result" ? vres.vertices.length : "",
          vecHoles: vres.type === "result" ? (vres.holeCount ?? 0) : "",
          vecMs: vecMs.toFixed(1),
          legStatus: lres.status, legAreaFrac: lFrac == null ? "" : lFrac.toFixed(6),
          legVerts: lres.verts ?? "", legMs: legMs.toFixed(1),
          legSolidRoom: lres.solidRoom ?? "",
          deltaPct: deltaPct == null ? "" : deltaPct.toFixed(3),
          iou: iouVal == null ? "" : iouVal.toFixed(4),
          vecEscapeX: vecEscapeX == null ? "" : vecEscapeX.toFixed(3),
          legEscapeX: legEscapeX == null ? "" : legEscapeX.toFixed(3),
          verdict,
          note: vres._msg ?? lres._msg ?? "",
        });
      }

      if (renderable.length) {
        await renderOverlays(id, pageNo, page, vp1, renderable, gw, gh);
      }

      if (typeof oc.releaseFloodScratch !== "function") {
        // A silent no-op here would hide the engine's scratch buffers being retained across the
        // whole corpus. Say it once rather than let a rename go unnoticed.
        if (!warnedScratch) { warnedScratch = true; process.stderr.write("\n!! oc.releaseFloodScratch is missing — flood scratch is NOT being released.\n"); }
      } else {
        oc.releaseFloodScratch();
      }
      page.cleanup();
      markPageDone(id, pageNo, picked.length);
      pagesDone++;
      // @napi-rs/canvas allocates natively, so V8 feels no pressure and defers collection: a
      // measured 24-page corpus-project run ramped 509 MB -> 3.8 GB before the first major GC. With
      // --expose-gc this holds it near steady; without, the ramp is real but survivable on this
      // box. Run the corpus as: node --expose-gc scripts/corpus-differential.mjs ...
      globalThis.gc?.();
      if (!quiet) {
        process.stderr.write(
          `\r[differential] ${id} p${pageNo}/${nPages}  ${picked.length} seed(s)  ` +
            `${(performance.now() - tPage).toFixed(0)} ms          `,
        );
      }
    } catch (e) {
      emit({
        pdf: id, page: pageNo, seedIdx: "", seedX: "", seedY: "", clearancePx: "",
        regionCells: "", regionFrac: "", sizeLog2: "", pageWpt: "", pageHpt: "", segCount: "", softSegs: "",
        imageFrac: "", gridW: "", gridH: "", otsu: "", filterSafe: "",
        vecStatus: "", vecAreaFrac: "", vecVerts: "", vecHoles: "", vecMs: "",
        legStatus: "", legAreaFrac: "", legVerts: "", legMs: "", legSolidRoom: "",
        deltaPct: "", iou: "", vecEscapeX: "", legEscapeX: "", verdict: "page-error", note: e?.message ?? String(e),
      });
      try { page?.cleanup(); } catch {}
    }
  }
  await doc.destroy();
  if (!quiet) process.stderr.write("\n");
}

/**
 * A picture per disagreement. Three numbers in a CSV cannot be checked by anyone; a sheet with
 * the seed marked, the vector outline in blue and the legacy region in red can be checked in two
 * seconds. This is unblocked-queue item 3, and it is what lets the owner catch "traced the wrong
 * region" without a deployed app.
 */
async function renderOverlays(id, pageNo, page, vp1, items, gw, gh) {
  // ⚠ THIS FUNCTION KILLED A 177-PAGE RUN. Two defects, both measured on bundle_a p57:
  //   1. The legacy mask was painted CELL BY CELL — up to gw*gh = 667,000 `fillRect` calls per
  //      overlay, times 11 overlays on that page. It is now one `putImageData` onto a gw*gh
  //      scratch canvas, composited with a single scaled `drawImage`.
  //   2. A FRESH full-size canvas was allocated per item: 1700x1133x4 ≈ 7.7 MB of NATIVE memory
  //      that V8 does not account for, so nothing pressured it to collect. Twelve per page, plus
  //      a PNG buffer each. The process was SIGKILLed with no stack and no log line. One canvas
  //      is now reused for the whole page, and the base render is redrawn onto it per item.
  // Overlays are also capped per page (--render-max-per-page): a dense sheet does not need a
  // dozen pictures, it needs the most extreme few.
  const ranked = [...items].sort((a, b) => {
    const ai = a.iouVal ?? -1, bi = b.iouVal ?? -1;      // lowest IoU = most divergent first
    if (ai !== bi) return ai - bi;
    return Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0);
  }).slice(0, renderMaxPerPage);
  if (items.length > ranked.length) overlaysSkipped += items.length - ranked.length;
  if (!ranked.length) return;

  const RS = 1700 / Math.max(vp1.width, vp1.height);
  const rvp = page.getViewport({ scale: RS });
  const W = Math.ceil(rvp.width), H = Math.ceil(rvp.height);
  const base = createCanvas(W, H);
  const bctx = base.getContext("2d");
  bctx.fillStyle = "#fff";
  bctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: bctx, viewport: rvp }).promise;

  // ONE overlay canvas, reused. ONE mask canvas at grid resolution, reused.
  const out = createCanvas(W, H);
  const g = out.getContext("2d");
  const maskCanvas = createCanvas(gw, gh);
  const mctx = maskCanvas.getContext("2d");
  const maskImg = mctx.createImageData(gw, gh);

  for (const it of ranked) {
    g.clearRect(0, 0, W, H);
    g.drawImage(base, 0, 0);

    // legacy region: one ImageData at grid resolution, one scaled composite
    if (it.lres.status === "ok" && it.lres.filled) {
      const d = maskImg.data;
      const filled = it.lres.filled;
      for (let i = 0, o = 0; i < filled.length; i++, o += 4) {
        if (filled[i]) { d[o] = 225; d[o + 1] = 29; d[o + 2] = 72; d[o + 3] = 72; }
        else { d[o + 3] = 0; }
      }
      mctx.putImageData(maskImg, 0, 0);
      g.drawImage(maskCanvas, 0, 0, gw, gh, 0, 0, W, H);
    }
    // vector polygon: normalised vertices straight onto the render
    if (it.vres.type === "result") {
      const path = (vs) => {
        g.beginPath();
        vs.forEach((v, i) => (i ? g.lineTo(v.x * W, v.y * H) : g.moveTo(v.x * W, v.y * H)));
        g.closePath();
      };
      path(it.vres.vertices);
      g.fillStyle = "rgba(14,165,233,0.24)";
      g.fill();
      g.strokeStyle = "#0284c7";
      g.lineWidth = 3;
      g.stroke();
      for (const hole of it.vres.holes ?? []) {
        path(hole.vertices);
        g.strokeStyle = "#7c3aed";
        g.lineWidth = 2;
        g.stroke();
      }
    }
    // the seed
    const sx = it.nx * W, sy = it.ny * H;
    g.beginPath(); g.arc(sx, sy, 11, 0, Math.PI * 2);
    g.fillStyle = "#fff"; g.fill();
    g.lineWidth = 4; g.strokeStyle = "#111"; g.stroke();
    g.beginPath(); g.arc(sx, sy, 4, 0, Math.PI * 2); g.fillStyle = "#111"; g.fill();

    g.fillStyle = "rgba(0,0,0,0.8)";
    g.fillRect(0, 0, W, 62);
    g.fillStyle = "#fff";
    g.font = "bold 20px sans-serif";
    g.fillText(`${id} p${pageNo} seed ${it.seedIdx} — ${it.verdict}`, 12, 26);
    g.font = "16px sans-serif";
    g.fillText(
      `vector ${it.vres.type === "result" ? (100 * it.vres.areaFraction).toFixed(3) + "% of sheet" : "REFUSED " + (it.vres.code ?? "")}` +
        `   ·   legacy ${it.lres.status === "ok" ? (100 * it.lres.areaFraction).toFixed(3) + "% of sheet" : it.lres.status}` +
        `   ·   IoU ${it.iouVal == null ? "—" : it.iouVal.toFixed(3)}` +
        `   ·   Δ ${it.deltaPct == null ? "—" : (it.deltaPct >= 0 ? "+" : "") + it.deltaPct.toFixed(1) + "%"}`,
      12, 50,
    );
    try {
      writeFileSync(
        join(renderDir, `${id}_p${String(pageNo).padStart(3, "0")}_s${it.seedIdx}_${it.verdict}.png`),
        out.toBuffer("image/png"),
      );
    } catch (e) {
      process.stderr.write(`\n!! overlay write failed for ${id} p${pageNo} s${it.seedIdx}: ${e?.message ?? e}\n`);
    }
  }
}

// ── the report ───────────────────────────────────────────────────────────────
const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
const med = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + "%" : "n/a");

const allClicks = rows.filter((r) => r.verdict && r.verdict !== "no-seedable-region" &&
  r.verdict !== "page-error" && r.verdict !== "page-budget-exceeded");

// ── TWO POPULATIONS, AND POOLING THEM WOULD BE A LIE ────────────────────────
// 56 of this corpus's 177 pages are scans (`scanned-set.pdf` in full). A scan has no vector
// linework, so the adapter returns `no-geometry` on EVERY click and production auto-routes the
// page to raster. That is the router working exactly as `RELEASE_LANGUAGE.md` promises
// ("Scanned sheets are unchanged"), but pooled into one refusal rate it prints ~32% and reads as
// an engine defect. Every headline below is therefore computed over VECTOR-CAPABLE pages only,
// and the scan pages get their own routing line. No row is dropped from the CSV either way.
const clicks = allClicks.filter((r) => num(r.segCount) > 0);
const scanClicks = allClicks.filter((r) => !(num(r.segCount) > 0));
const scanPages = new Set(scanClicks.map((r) => `${r.pdf}|${r.page}`)).size;
const vecPages = new Set(clicks.map((r) => `${r.pdf}|${r.page}`)).size;

const byVerdict = new Map();
for (const r of clicks) byVerdict.set(r.verdict, (byVerdict.get(r.verdict) ?? 0) + 1);

const out = [
  "",
  "═".repeat(80),
  " PHASE-3 DIFFERENTIAL — VECTOR vs LEGACY on real drawings, NO ORACLE",
  "═".repeat(80),
  ` corpus       ${DIR}`,
  ` pdfs         ${pdfs.length}   pages measured ${pagesDone}${pagesSkipped ? ` (+${pagesSkipped} resumed)` : ""}`,
  ` population   ${vecPages} vector-capable page(s), ${clicks.length} click(s)  ←  every headline below`,
  `              ${scanPages} scan page(s), ${scanClicks.length} click(s)  —  reported separately, never pooled`,
  ` sampling     seeds/page ≤ ${seedsPerPage} · min-cells ${minCells} · regions > ${(100 * LEAK_FRACTION).toFixed(0)}% of sheet not seeded`,
  `              dropped: ${dropped.tooSmall} too small · ${dropped.tooLarge} sheet-sized · ${dropped.overBudget} over the per-page budget`,
  `              ⚠ min-cells and the per-page budget are SAMPLING BUDGET, not engine limits`,
  `                (CANON rule 7: the engine has no size floor). The ${(100 * LEAK_FRACTION).toFixed(0)}% drop is different — that`,
  `                one IS the engine's own LEAK_FRACTION constant, reused here to skip the page`,
  `                margin and the outside-the-building void.`,
  "",
  " AGREEMENT / DISAGREEMENT (one row per click, vector-capable pages):",
];
const ORDER = [
  "agree-same-region", "agree-area-differ-region", "disagree",
  "vector-refused-only", "vector-refused-legacy-leaked",
  "legacy-failed-only", "legacy-failed-vector-leaked",
  "vector-implausible", "legacy-implausible", "both-implausible", "both-failed",
];
for (const k of [...ORDER, ...[...byVerdict.keys()].filter((k) => !ORDER.includes(k))]) {
  const n = byVerdict.get(k);
  if (!n) continue;
  out.push(`   ${k.padEnd(30)} ${String(n).padStart(6)}   ${pct(n, clicks.length).padStart(7)}` +
    (k === "agree-area-differ-region" ? "   ← same AREA, different PLACE. Not agreement." : ""));
}

// ── AGREEMENT means agree-same-region ONLY. `startsWith("agree")` would fold in
// `agree-area-differ-region`, which is the exact verdict the taxonomy exists to separate:
// two engines returning the same number for different parts of the sheet.
const isAgreement = (r) => r.verdict === "agree-same-region";

// refusal rate, per engine, first class (PLAN §6 metrics)
const vecRefused = clicks.filter((r) => r.vecStatus !== "ok").length;
const legFailed = clicks.filter((r) => r.legStatus !== "ok").length;
const vecCodes = new Map();
for (const r of clicks) if (r.vecStatus !== "ok") vecCodes.set(r.vecStatus, (vecCodes.get(r.vecStatus) ?? 0) + 1);
out.push(
  "",
  " REFUSAL RATE — a first-class metric, not an inconvenience (vector-capable pages only):",
  `   vector refused ${vecRefused}/${clicks.length} = ${pct(vecRefused, clicks.length)}` +
    `   [${[...vecCodes.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}]`,
  `   legacy failed  ${legFailed}/${clicks.length} = ${pct(legFailed, clicks.length)}`,
);
if (scanClicks.length) {
  const scanRefused = scanClicks.filter((r) => r.vecStatus !== "ok").length;
  const scanNoGeom = scanClicks.filter((r) => r.vecStatus === "no-geometry").length;
  out.push(
    ` ROUTING CHECK — scan pages (${scanPages} page(s), ${scanClicks.length} click(s)), NOT part of the refusal rate:`,
    `   vector declined ${scanRefused}/${scanClicks.length} = ${pct(scanRefused, scanClicks.length)}` +
      `   (${scanNoGeom} as no-geometry). 100% is the CORRECT answer — these route to raster.`,
  );
}

// ── the RC4 thesis, stated so it cannot be misread ───────────────────────────
// ⚠ "vector confidently wrong = 0" is TRUE BY CONSTRUCTION, not a measurement. floodRegion caps
// the fill at `Math.floor(mw * mh * LEAK_FRACTION)` and returns status `leak` beyond it
// (oneclick.ts:576,607), so a vector result with status ok and area > LEAK_FRACTION cannot exist.
// Printing that zero next to the legacy count as if both were empirical would be exactly the kind
// of true-but-meaningless headline this project keeps having to retract. The measurable form of
// RC4 is the one below it: on the clicks where LEGACY silently returned a sheet-sized area, what
// did vector do?
const lImp = clicks.filter((r) => r.legStatus === "ok" && num(r.legAreaFrac) > LEAK_FRACTION);
const escaped = (col) => clicks.filter((r) => {
  const x = num(r[col]);
  return x != null && x > ESCAPE_X;
});
const legEsc = escaped("legEscapeX");
const vecEsc = escaped("vecEscapeX");
const legEscVecRefused = legEsc.filter((r) => r.vecStatus !== "ok").length;
const legEscVecEscaped = legEsc.filter((r) => num(r.vecEscapeX) > ESCAPE_X).length;
const legEscVecHeld = legEsc.length - legEscVecRefused - legEscVecEscaped;
out.push(
  "",
  ` CONFIDENTLY WRONG — status ok, no warning, and the answer is not the space that was clicked:`,
  `   (a) area > ${(100 * LEAK_FRACTION).toFixed(0)}% of the sheet   legacy ${lImp.length}/${clicks.length} = ${pct(lImp.length, clicks.length)}`,
  `       vector 0 here is BY CONSTRUCTION, not measured — floodRegion caps at LEAK_FRACTION and`,
  `       returns status "leak" beyond it (oneclick.ts:576,607). That zero is not evidence, and`,
  `       the threshold is blind besides: a sheet whose outside void is 17% of the page hides a`,
  `       total leak underneath it.`,
  `   (b) ESCAPED THE CLICKED SPACE by >${ESCAPE_X}x its neutral-field region — the real detector:`,
  `       legacy ${legEsc.length}/${clicks.length} = ${pct(legEsc.length, clicks.length)}`,
  `       vector ${vecEsc.length}/${clicks.length} = ${pct(vecEsc.length, clicks.length)}`,
);
if (legEsc.length) {
  out.push(
    ` RC4 AS AN ACTUAL MEASUREMENT — on the ${legEsc.length} click(s) where LEGACY escaped:`,
    `   vector REFUSED and said so           ${legEscVecRefused}  = ${pct(legEscVecRefused, legEsc.length)}`,
    `   vector stayed in the clicked space   ${legEscVecHeld}  = ${pct(legEscVecHeld, legEsc.length)}`,
    `   vector escaped too                   ${legEscVecEscaped}  = ${pct(legEscVecEscaped, legEsc.length)}`,
    `   ⇒ the first two rows are the port's thesis holding; the third is it not holding.`,
  );
}

// where both measured something plausible, how far apart are they?
const both = clicks.filter(
  (r) => r.vecStatus === "ok" && r.legStatus === "ok" &&
    num(r.vecAreaFrac) <= LEAK_FRACTION && num(r.legAreaFrac) <= LEAK_FRACTION,
);
const deltas = both.map((r) => num(r.deltaPct)).filter((v) => v != null);
const ious = both.map((r) => num(r.iou)).filter((v) => v != null);
if (deltas.length) {
  const absD = deltas.map(Math.abs).sort((a, b) => a - b);
  const p = (q) => absD[Math.min(absD.length - 1, Math.floor(q * absD.length))];
  out.push(
    "",
    ` WHERE BOTH MEASURED A PLAUSIBLE REGION (n=${both.length}):`,
    `   signed Δarea (vector vs legacy)   median ${med(deltas) >= 0 ? "+" : ""}${med(deltas).toFixed(2)}%` +
      `   |Δ| p50 ${p(0.5).toFixed(2)}%  p90 ${p(0.9).toFixed(2)}%  max ${absD[absD.length - 1].toFixed(2)}%`,
    `   region IoU                        median ${ious.length ? med(ious).toFixed(4) : "n/a"}` +
      `   ≥${IOU_SAME} on ${pct(ious.filter((v) => v >= IOU_SAME).length, ious.length)}`,
    "",
    "   ⚠ READ THIS BEFORE QUOTING EITHER NUMBER. Three known biases sit inside them, all in",
    "     the same direction, and none is an engine defect:",
    "     1. BOUNDARY DEFINITION. Vector floods to the wall CENTRELINE minus one mask px; legacy",
    "        stops at the rendered stroke's INNER FACE. On synthetic single-stroke walls that gap",
    "        alone is 1.3-1.6% (oneclick-accuracy.mjs's dual oracle exists solely to cancel it),",
    "        and it grows with perimeter/area — so small regions read as disagreeing when both",
    "        engines are correct. A signed Δ near +1-2% is the FLOOR here, not a finding.",
    "     2. SHAPE REPRESENTATION. The vector side is an RDP-simplified polygon rasterised back",
    "        onto the grid; the legacy side is its raw pixel mask. IoU therefore charges vector",
    "        for simplification the legacy leg is never asked to pay.",
    "     3. HOLES. `rasterizeVector` subtracts only holes the product deems significant, while",
    "        the legacy mask excludes every hole it flooded around.",
    "   ⇒ Treat a large |Δ| or a low IoU as a place to LOOK (use --render), not as a percentage",
    "     to publish. `notes/RELEASE_LANGUAGE.md` §3 still has no number it is entitled to give,",
    "     and this run does not by itself supply one.",
  );
}

// ── by region size. A pooled agreement rate over a sample dominated by specks says nothing
// about the rooms an estimator actually clicks, and CANON rule 7 forbids solving that by
// excluding the small ones. Report both instead.
const strataRows = new Map();
for (const r of clicks) {
  const b = num(r.sizeLog2);
  if (b == null) continue;
  if (!strataRows.has(b)) strataRows.set(b, []);
  strataRows.get(b).push(r);
}
if (strataRows.size) {
  out.push("", " BY REGION SIZE (neutral-grid cells; 2^b .. 2^(b+1)-1) — the specks and the rooms, separately:");
  for (const [b, rs] of [...strataRows.entries()].sort((a, b2) => b2[0] - a[0])) {
    const agree = rs.filter(isAgreement).length;
    const vr = rs.filter((r) => r.vecStatus !== "ok").length;
    const lf = rs.filter((r) => r.legStatus !== "ok").length;
    const is = rs.map((r) => num(r.iou)).filter((v) => v != null);
    out.push(
      `   2^${String(b).padStart(2)} (≥${String(2 ** b).padStart(7)} cells)  n=${String(rs.length).padStart(5)}` +
        `   agree ${pct(agree, rs.length).padStart(6)}   vec-refused ${pct(vr, rs.length).padStart(6)}` +
        `   leg-failed ${pct(lf, rs.length).padStart(6)}   median IoU ${is.length ? med(is).toFixed(3) : "  n/a"}`,
    );
  }
}

// per-PDF breakdown: an average over one atypical sheet is not a corpus result
out.push("", " PER PDF:");
const perPdf = new Map();
for (const r of clicks) {
  if (!perPdf.has(r.pdf)) perPdf.set(r.pdf, []);
  perPdf.get(r.pdf).push(r);
}
for (const [id, rs] of [...perPdf.entries()].sort()) {
  const agree = rs.filter(isAgreement).length;
  const vr = rs.filter((r) => r.vecStatus !== "ok").length;
  const lf = rs.filter((r) => r.legStatus !== "ok").length;
  const li = rs.filter((r) => r.legStatus === "ok" && num(r.legAreaFrac) > LEAK_FRACTION).length;
  const vi = rs.filter((r) => r.vecStatus === "ok" && num(r.vecAreaFrac) > LEAK_FRACTION).length;
  out.push(
    `   ${id.padEnd(18)} clicks ${String(rs.length).padStart(5)}   agree ${pct(agree, rs.length).padStart(6)}` +
      `   vec-refused ${pct(vr, rs.length).padStart(6)}   leg-failed ${pct(lf, rs.length).padStart(6)}` +
      `   confidently-wrong vec ${pct(vi, rs.length).padStart(6)} / leg ${pct(li, rs.length).padStart(6)}`,
  );
}

// timing — per-click cost of each engine on real sheets
const vms = clicks.map((r) => num(r.vecMs)).filter((v) => v != null);
const lms = clicks.map((r) => num(r.legMs)).filter((v) => v != null);
if (vms.length) {
  const s = (a) => { const x = [...a].sort((p, q) => p - q); return { p50: x[x.length >> 1], p95: x[Math.floor(0.95 * x.length)], max: x[x.length - 1] }; };
  const v = s(vms), l = s(lms);
  out.push(
    "",
    " COST PER CLICK on real sheets — ⚠ THE TWO LEGS ARE NOT COMPARABLE HERE:",
    `   vector  COLD: rebuilds the mask every click. p50 ${v.p50.toFixed(1)} ms  p95 ${v.p95.toFixed(1)} ms  max ${v.max.toFixed(1)} ms`,
    "           Production does NOT do this — worker #2 builds the mask once per page and serves",
    "           warm clicks from it. This number is an upper bound, not the user's experience.",
    `   legacy  WARM: flood+trace only. p50 ${l.p50.toFixed(1)} ms  p95 ${l.p95.toFixed(1)} ms  max ${l.max.toFixed(1)} ms`,
    "           Its render+binarize is amortised per PAGE here; production pays it per CLICK.",
    "   ⇒ Each leg is quoted on its own favourable footing. For a real comparison use",
    "     scripts/probes/e2e-oneclick.mjs, which breaks out every stage. (node + @napi-rs/canvas;",
    "     Chrome is still unmeasured — PLAN §9 U1.)",
  );
}

const pageProblems = rows.filter((r) => r.verdict === "page-error" || r.verdict === "page-budget-exceeded" || r.verdict === "no-seedable-region");
if (pageProblems.length) {
  out.push("", ` PAGES THAT PRODUCED NO CLICKS (${pageProblems.length}) — listed, never silently dropped:`);
  for (const r of pageProblems.slice(0, 25)) out.push(`   ${r.pdf} p${r.page}  ${r.verdict}  ${r.note}`);
  if (pageProblems.length > 25) out.push(`   … and ${pageProblems.length - 25} more (see the CSV)`);
}

if (renderDir && overlaysSkipped) {
  out.push(
    "",
    ` OVERLAYS: capped at ${renderMaxPerPage}/page (most divergent first) — ${overlaysSkipped} not drawn.`,
    "   Every one of them is still a row in the CSV; only the picture was skipped.",
  );
}
out.push("═".repeat(80), "");
process.stderr.write(out.join("\n"));

if (summaryJson) {
  writeFileSync(summaryJson, JSON.stringify({
    dir: DIR, pdfs, pagesDone, pagesSkipped, clicks: clicks.length,
    sampling: { seedsPerPage, minCells, leakFraction: LEAK_FRACTION, dropped },
    params: { maskDim, maxDim, tolerance, dilation, renderLongSide, renderScaleOverride, agreePct: AGREE_PCT, iouSame: IOU_SAME, escapeX: ESCAPE_X },
    population: {
      vectorCapablePages: vecPages, vectorCapableClicks: clicks.length,
      scanPages, scanClicks: scanClicks.length,
      note: "every field below is over VECTOR-CAPABLE pages only; scan pages route to raster by design",
    },
    verdicts: Object.fromEntries(byVerdict),
    refusal: { vector: vecRefused, legacy: legFailed, vectorCodes: Object.fromEntries(vecCodes) },
    escaped: { legacy: legEsc.length, vector: vecEsc.length, threshold: ESCAPE_X,
      onLegacyEscape: { vectorRefused: legEscVecRefused, vectorHeld: legEscVecHeld, vectorEscapedToo: legEscVecEscaped } },
    confidentlyWrong: {
      legacy: lImp.length,
      vector: 0,
      vectorIsZeroByConstruction: true,
      why: "floodRegion caps at LEAK_FRACTION and returns status 'leak' beyond it (oneclick.ts:576,607)",
      onLegacyLeaks: { vectorRefused: lImpVecRefused, vectorBounded: lImpVecBounded },
    },
    bothPlausible: {
      n: both.length,
      medianSignedDeltaPct: deltas.length ? med(deltas) : null,
      medianIoU: ious.length ? med(ious) : null,
    },
  }, null, 2) + "\n");
  if (!quiet) console.error(`[differential] summary → ${summaryJson}`);
}
