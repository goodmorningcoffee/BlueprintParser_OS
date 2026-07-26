// ADOPTED into the repo 2026-07-26 (PLAN §5 phase 0 item 3). Behaviour unchanged; the only
// edit is path resolution — the original hardcoded absolute paths, which is the workspace's
// recurring silent-failure bug class. See ./_paths.mjs.
// R2 PHYSICS PROBE — does OpenTakeoff's oneclick.ts engine actually RUN, end to end,
// outside their app, driven by BP2's own pdfjs-dist?
//
// Pipeline exercised (their real exported functions, no transcription):
//   page.getOperatorList()
//   extractVectorGeometry(opList, viewport.transform, pdfjs.OPS)
//   buildMask(segs, imgW, imgH, maskDim, meta)          <- includes classifyHatchSegs
//   floodRegion(maskObj, sx, sy, sensitivity)
//   traceRegion(floodResult, eps) + ringArea
//   roomLabelSeeds/detectRegions (detectRooms.ts) from the PDF text layer
//
// Read-only against both trees. Writes nothing. Node 24 type-stripping loads the .ts
// modules directly — no build step, no bundler, no tsconfig.
//
// usage: node e2e-oneclick.mjs <pdf> [page=1] [maskDim=3000] [scale=2]
import { readFileSync, statSync } from "node:fs";
import { loadPdfjs, loadEngine, loadCanvas, enginePath, densityFixture, loadDetectRooms } from "./_paths.mjs";


const pdfjs = await loadPdfjs();
const oc = await loadEngine();
const dr = await loadDetectRooms();

const file = process.argv[2];
const pageNo = Number(process.argv[3] ?? 1);
const maskDim = Number(process.argv[4] ?? 3000);
const scale = Number(process.argv[5] ?? 2);

const ms = (t) => `${t.toFixed(1)}`;
const mb = (b) => `${(b / 1048576).toFixed(1)}MB`;
const bytes = statSync(file).size;
const data = new Uint8Array(readFileSync(file));

const T = {};
let t0 = performance.now();
const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
T.docLoad = performance.now() - t0;

const page = await doc.getPage(pageNo);
const vp = page.getViewport({ scale });
const vp1 = page.getViewport({ scale: 1 });
const imgW = vp.width, imgH = vp.height;

const m0 = process.memoryUsage();
t0 = performance.now();
const opList = await page.getOperatorList();
T.getOperatorList = performance.now() - t0;
const mAfterOp = process.memoryUsage();

t0 = performance.now();
const geo = oc.extractVectorGeometry(opList, vp.transform, pdfjs.OPS);
T.extractVectorGeometry = performance.now() - t0;
const mAfterExtract = process.memoryUsage();

const segCount = geo.segs.length >> 2;
const imageFrac = Math.min(1, geo.imageArea / (imgW * imgH));

t0 = performance.now();
const maskObj = oc.buildMask(geo.segs, imgW, imgH, maskDim, geo.meta);
T.buildMask = performance.now() - t0;

// buildMask WITHOUT meta = no hatch classification, for the classify-cost split
t0 = performance.now();
const maskNoMeta = oc.buildMask(geo.segs, imgW, imgH, maskDim, null);
T.buildMask_noHatch = performance.now() - t0;
const mAfterMask = process.memoryUsage();

let maskInk = 0, maskSoft = 0;
for (let i = 0; i < maskObj.mask.length; i++) { if (maskObj.mask[i] & 1) maskInk++; if (maskObj.mask[i] & 2) maskSoft++; }

console.log(`## file=${file.split("/").pop()} page=${pageNo} bytes=${bytes} pages=${doc.numPages}`);
console.log(`   viewport@1 = ${vp1.width.toFixed(0)}x${vp1.height.toFixed(0)}pt   image px @scale ${scale} = ${imgW.toFixed(0)}x${imgH.toFixed(0)}`);
console.log(`   ops=${opList.fnArray.length} segs=${segCount} points=${geo.points.length} imageArea=${geo.imageArea.toExponential(2)} imageFrac=${imageFrac.toFixed(4)}`);
console.log(`   rasterEligible(imageFrac>=0.10)=${imageFrac >= 0.10}  vectorViable(segs>=500)=${segCount >= 500}`);
console.log(`   mask ${maskObj.mw}x${maskObj.mh} ws=${maskObj.ws.toFixed(4)} softCount=${maskObj.softCount}/${segCount} inkCells=${maskInk} softCells=${maskSoft} (${(100 * maskInk / (maskObj.mw * maskObj.mh)).toFixed(2)}% hard ink)`);
console.log(`-- ACQUISITION ms: docLoad=${ms(T.docLoad)} getOperatorList=${ms(T.getOperatorList)} extractVectorGeometry=${ms(T.extractVectorGeometry)} buildMask(+hatch)=${ms(T.buildMask)} buildMask(noHatch)=${ms(T.buildMask_noHatch)}`);
console.log(`   classifyHatchSegs cost = ${ms(T.buildMask - T.buildMask_noHatch)} ms (difference)`);
console.log(`-- heapUsed: start=${mb(m0.heapUsed)} afterOpList=${mb(mAfterOp.heapUsed)} afterExtract=${mb(mAfterExtract.heapUsed)} afterMask=${mb(mAfterMask.heapUsed)}  rss=${mb(mAfterMask.rss)}`);
console.log(`   derived geometry bytes: segs(f64)=${mb(geo.segs.length * 8)} points=${mb(geo.points.length * (8 * 2 + 32))} meta=${mb(geo.meta.length)} mask=${mb(maskObj.mask.length)}`);

// ── the CLICK: flood + trace, timed as the user would feel it ────────────────
function clickAt(x, y, sens = oc.SENS_BALANCED, eps = 1.5) {
  const a = performance.now();
  const f = oc.floodRegion(maskObj, x, y, sens);
  const b = performance.now();
  if (f.status !== "ok") return { status: f.status, floodMs: b - a, traceMs: 0, verts: 0, area: 0 };
  const ring = oc.traceRegion(f, eps);
  const c = performance.now();
  return { status: "ok", floodMs: b - a, traceMs: c - b, verts: ring.length, area: oc.ringArea(ring), count: f.count, hatchFiltered: !!f.hatchFiltered };
}

// A) text-layer seeds — their OWN detectRooms path, the realistic "real room" seed set
t0 = performance.now();
const tc = await page.getTextContent();
T.getTextContent = performance.now() - t0;
const items = [];
for (const it of tc.items || []) {
  if (!it.str || !it.str.trim()) continue;
  const t = pdfjs.Util.transform(vp.transform, it.transform);
  items.push({ str: it.str, x: t[4], y: t[5] });
}
const seeds = dr.roomLabelSeeds(items);
console.log(`-- TEXT LAYER: items=${items.length} getTextContentMs=${ms(T.getTextContent)} roomLabelSeeds=${seeds.length}`);

const perClick = [];
const statusHist = {};
let okRings = 0, totalArea = 0, maxVerts = 0;
t0 = performance.now();
for (const s of seeds.slice(0, 400)) {
  const r = clickAt(s.seed[0], s.seed[1]);
  statusHist[r.status] = (statusHist[r.status] ?? 0) + 1;
  perClick.push(r.floodMs + r.traceMs);
  if (r.status === "ok") { okRings++; totalArea += r.area; maxVerts = Math.max(maxVerts, r.verts); }
}
T.allLabelClicks = performance.now() - t0;
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0; };
console.log(`   label-seed clicks n=${perClick.length} statuses=${JSON.stringify(statusHist)} okRings=${okRings} maxVerts=${maxVerts}`);
if (perClick.length) console.log(`   flood+trace ms: min=${ms(Math.min(...perClick))} p50=${ms(pct(perClick, .5))} p95=${ms(pct(perClick, .95))} max=${ms(Math.max(...perClick))} totalForAll=${ms(T.allLabelClicks)}`);

// B) grid sweep — an unbiased sample of "where a user might click"
const GX = Number(process.env.GX ?? 24), GY = Number(process.env.GY ?? 18);
const gridTimes = [], gridHist = {};
const okAreas = [];
t0 = performance.now();
for (let gy = 1; gy < GY; gy++) for (let gx = 1; gx < GX; gx++) {
  const r = clickAt((imgW * gx) / GX, (imgH * gy) / GY);
  gridHist[r.status] = (gridHist[r.status] ?? 0) + 1;
  gridTimes.push(r.floodMs + r.traceMs);
  if (r.status === "ok") okAreas.push({ area: r.area, verts: r.verts, count: r.count });
}
T.gridSweep = performance.now() - t0;
console.log(`-- GRID SWEEP ${GX}x${GY}: n=${gridTimes.length} statuses=${JSON.stringify(gridHist)}`);
console.log(`   flood+trace ms: min=${ms(Math.min(...gridTimes))} p50=${ms(pct(gridTimes, .5))} p95=${ms(pct(gridTimes, .95))} max=${ms(Math.max(...gridTimes))} sweepTotal=${ms(T.gridSweep)}`);
if (okAreas.length) {
  const vs = okAreas.map((o) => o.verts);
  console.log(`   ok regions: n=${okAreas.length} verts min/p50/max=${Math.min(...vs)}/${pct(vs, .5)}/${Math.max(...vs)}  areaPx2 p50=${pct(okAreas.map(o => o.area), .5).toExponential(2)}`);
}

// C) the worst realistic single click: a LEAK (floods to the cap) and a full-room fill
const leakSample = [];
for (let k = 0; k < 5; k++) { const a = performance.now(); oc.floodRegion(maskObj, 5, 5); leakSample.push(performance.now() - a); }
console.log(`-- corner seed (leak/boundary path) x5 ms: ${leakSample.map((v) => v.toFixed(1)).join(" ")}`);

// D) mask rebuild cost if the cache is cold on click (the "no prefetch" penalty)
const rebuild = [];
for (let k = 0; k < 3; k++) { const a = performance.now(); oc.buildMask(geo.segs, imgW, imgH, maskDim, geo.meta); rebuild.push(performance.now() - a); }
console.log(`-- buildMask rebuild x3 ms: ${rebuild.map((v) => v.toFixed(0)).join(" ")}`);

const mEnd = process.memoryUsage();
console.log(`-- END heapUsed=${mb(mEnd.heapUsed)} rss=${mb(mEnd.rss)} external=${mb(mEnd.external)} arrayBuffers=${mb(mEnd.arrayBuffers)}`);

// E) does page.cleanup() actually release the op-list retention? (G20 / J3 C3)
if (process.env.CLEANUP === "1") {
  global.gc?.();
  const before = process.memoryUsage();
  const dropped = page.cleanup();
  global.gc?.();
  await new Promise((r) => setTimeout(r, 50));
  global.gc?.();
  const after = process.memoryUsage();
  console.log(`-- page.cleanup() returned=${dropped}  heapUsed ${mb(before.heapUsed)} -> ${mb(after.heapUsed)} (delta ${mb(before.heapUsed - after.heapUsed)})`);
}
await doc.destroy();
