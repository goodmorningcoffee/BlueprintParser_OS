#!/usr/bin/env node

/**
 * OTSU-SHIFT PROBE — how much does the legacy binarization threshold move, and what does the
 * movement COST in square feet?  (PLAN §5 phase 0 item 4; RC2 magnitude; §9 U3.)
 *
 * The legacy engine picks ONE global Otsu threshold from the histogram of whatever raster it
 * was handed, then floods through pixels above it. So the number a user commits depends on the
 * render conditions the raster came from. This probe measures that dependency on real sheets.
 *
 * ── WHAT IT MEASURES, AND WHY THE THRESHOLD IS THE LESS INTERESTING HALF ────────────────
 * A threshold delta is only a defect if it moves the ANSWER. So for every render condition
 * this reports both:
 *     otsu        the threshold the worker's own code would pick
 *     areaPt2     the flooded area at a FIXED seed, through that threshold
 * The second column is RC2's actual magnitude. A 24-level threshold shift that moves the area
 * by 0.1% is a curiosity; one that moves it by 5% is a support ticket.
 *
 * ── THE DARK BORDER *IS* GUILTY ON REAL SHEETS (this header previously said otherwise) ──
 * PLAN item 4 names "the dark-border case". A synthetic fixture measured no shift at all — 129
 * with the border and 129 without — and this file originally recorded it as cleared. THAT WAS
 * WRONG, and this probe is what refuted it: on real sheets the border moves the threshold by
 * 40 levels (VA p1, 181 -> 141) and 31 (VA p2, 175 -> 144). The synthetic was four lines on
 * white, a histogram too one-sided for a dark band to move the between-class variance peak.
 * A clean synthetic result is the easiest kind to over-generalize, precisely because it is
 * unambiguous. The border is kept as a CONDITION here, not a control.
 *
 * Everything downstream of getImageData is the worker's OWN exported code
 * (bucketRgbaHistogram / bucketRgbaBinarize / floodFill), with its Otsu loop transcribed —
 * the same MIRROR: relationship the accuracy harness documents and parity-checks.
 *
 *   node scripts/probes/otsu-shift.mjs <pdf> [page=1] [--seeds 3]
 */

// Side-effect import: teaches bare node the "@/" alias + extensionless .ts. MUST come first.
import "./_ts-resolve.mjs";
import { readFileSync } from "node:fs";
import { loadPdfjs, loadCanvas, enginePath } from "./_paths.mjs";

globalThis.self ??= { addEventListener() {}, postMessage() {} };

const pdfjs = await loadPdfjs();
const { createCanvas } = await loadCanvas();
const REPO = new URL("../..", import.meta.url).pathname;
const W = await import(`${REPO}/src/workers/bucket-fill.worker.ts`);
const dr = await import(enginePath().replace("oneclick.ts", "detectRooms.ts"));

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/probes/otsu-shift.mjs <pdf> [page] [--seeds N]");
  process.exit(2);
}
const pageNo = Number(process.argv[3] ?? 1);
const nSeeds = Number((process.argv.find((a) => a.startsWith("--seeds="))?.split("=")[1]) ?? 3);

// MIRROR: the Otsu loop from downscaleAndBinarize (bucket-fill.worker.ts:143-164), verbatim.
function otsuOf(rgba, n) {
  const { hist } = W.bucketRgbaHistogram(rgba, n, true);
  let sum = 0;
  for (let v = 0; v < hist.length; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, maxVar = 0, threshold = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = t; }
  }
  return threshold;
}

const data = new Uint8Array(readFileSync(file));
const doc = await pdfjs.getDocument({
  data,
  isEvalSupported: false,
  standardFontDataUrl: `${REPO}/node_modules/pdfjs-dist/standard_fonts/`,
}).promise;
const page = await doc.getPage(pageNo);
const vp1 = page.getViewport({ scale: 1 });
const pageWpt = vp1.width, pageHpt = vp1.height;

// Seeds from the sheet's own text layer — the realistic "where a user clicks" population,
// and the same path the product uses to find rooms.
const tc = await page.getTextContent();
const items = [];
for (const it of tc.items || []) {
  if (!it.str || !it.str.trim()) continue;
  const t = pdfjs.Util.transform(vp1.transform, it.transform);
  items.push({ str: it.str, x: t[4], y: t[5] });
}
const seeds = (dr.roomLabelSeeds(items) || []).slice(0, nSeeds);

console.log(`## ${file.split("/").pop()} page ${pageNo}  ${pageWpt.toFixed(0)}x${pageHpt.toFixed(0)}pt  seeds=${seeds.length}`);
if (!seeds.length) {
  console.log("   no room-label seeds on this page — nothing to measure");
  await doc.destroy();
  process.exit(0);
}

async function renderAt(scale, { darkBorder = false } = {}) {
  const vp = page.getViewport({ scale });
  const cv = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const c = cv.getContext("2d");
  c.fillStyle = "#fff";
  c.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: c, viewport: vp }).promise;
  if (darkBorder) {
    c.fillStyle = "#1a1a1a";
    const b = Math.round(0.035 * Math.min(cv.width, cv.height));
    c.fillRect(0, 0, cv.width, b);
    c.fillRect(0, cv.height - b, cv.width, b);
    c.fillRect(0, 0, b, cv.height);
    c.fillRect(cv.width - b, 0, b, cv.height);
  }
  return cv;
}

// MIRROR: downscaleAndBinarize's downscale step, then the worker's own binarize.
function binarizeLikeWorker(srcCanvas, maxDim, tolerance = 30) {
  const ratio = Math.min(maxDim / srcCanvas.width, maxDim / srcCanvas.height, 1);
  const w = Math.round(srcCanvas.width * ratio), h = Math.round(srcCanvas.height * ratio);
  const cv = createCanvas(w, h);
  const c = cv.getContext("2d");
  c.fillStyle = "#fff";
  c.fillRect(0, 0, w, h);
  c.drawImage(srcCanvas, 0, 0, w, h);
  const rgba = c.getImageData(0, 0, w, h).data;
  const n = w * h;
  const otsu = otsuOf(rgba, n);
  const adjusted = Math.max(0, Math.min(255, otsu + (30 - tolerance)));
  return { bin: W.bucketRgbaBinarize(rgba, n, adjusted), w, h, otsu, adjusted };
}

const CONDITIONS = [
  { label: "render@1.0 maxDim1000", scale: 1.0, maxDim: 1000 },
  { label: "render@1.5 maxDim1000", scale: 1.5, maxDim: 1000 },
  { label: "render@2.0 maxDim1000", scale: 2.0, maxDim: 1000 },
  { label: "render@2.0 maxDim1500", scale: 2.0, maxDim: 1500 },
  { label: "render@2.0 maxDim2000", scale: 2.0, maxDim: 2000 },
  { label: "render@2.0 +darkBorder", scale: 2.0, maxDim: 1000, darkBorder: true },
];

const rows = [];
for (const cond of CONDITIONS) {
  const cv = await renderAt(cond.scale, { darkBorder: cond.darkBorder });
  const { bin, w, h, otsu, adjusted } = binarizeLikeWorker(cv, cond.maxDim);
  const areas = [];
  for (const s of seeds) {
    // roomLabelSeeds returns viewport-scale-1 device px; normalise then map onto this raster.
    const sx = Math.max(0, Math.min(w - 1, Math.round((s.seed[0] / pageWpt) * w)));
    const sy = Math.max(0, Math.min(h - 1, Math.round((s.seed[1] / pageHpt) * h)));
    const f = W.floodFill(bin, w, h, sx, sy);
    areas.push(f.area >= 20 ? (f.area / (w * h)) * pageWpt * pageHpt : null);
  }
  rows.push({ ...cond, otsu, adjusted, w, h, areas });
  console.log(
    `   ${cond.label.padEnd(24)} raster ${String(w).padStart(4)}x${String(h).padStart(4)}  ` +
      `otsu=${String(otsu).padStart(3)}  areas=${areas.map((a) => (a == null ? "  refused" : a.toFixed(0).padStart(8))).join(" ")}`,
  );
}

// ── the verdict: threshold spread, and what it COSTS ─────────────────────────
const thresholds = rows.map((r) => r.otsu);
const tSpread = Math.max(...thresholds) - Math.min(...thresholds);
console.log(`\n   OTSU SPREAD across render conditions: ${Math.min(...thresholds)}..${Math.max(...thresholds)} = ${tSpread} levels`);

for (let i = 0; i < seeds.length; i++) {
  const vals = rows.map((r) => r.areas[i]).filter((v) => v != null);
  if (vals.length < 2) {
    console.log(`   seed ${i}: fewer than 2 measurable conditions (refusals) — no spread`);
    continue;
  }
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const mid = vals.slice().sort((a, b) => a - b)[vals.length >> 1];
  console.log(
    `   seed ${i}: area ${lo.toFixed(0)}..${hi.toFixed(0)} pt²  = ${(100 * (hi - lo) / mid).toFixed(2)}% spread` +
      `  (${rows.length - vals.length} refusal(s))`,
  );
}

const borderRow = rows.find((r) => r.darkBorder);
const cleanRow = rows.find((r) => !r.darkBorder && r.scale === borderRow?.scale && r.maxDim === borderRow?.maxDim);
if (borderRow && cleanRow) {
  console.log(
    `\n   DARK-BORDER CONTROL: otsu ${cleanRow.otsu} -> ${borderRow.otsu} ` +
      `(${borderRow.otsu === cleanRow.otsu ? "NO SHIFT — the suspect stays cleared" : `shift of ${borderRow.otsu - cleanRow.otsu}`})`,
  );
}
await doc.destroy();
