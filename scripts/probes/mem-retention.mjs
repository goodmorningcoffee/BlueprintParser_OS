// ADOPTED into the repo 2026-07-26 (PLAN §5 phase 0 item 3). Behaviour unchanged; the only
// edit is path resolution — the original hardcoded absolute paths, which is the workspace's
// recurring silent-failure bug class. See ./_paths.mjs.
// R2 PHYSICS PROBE — what does ONE page of vector geometry actually RETAIN?
// Isolates the four terms the plan's cache budget (4 pages / 24 MB, G9) depends on:
//   1. the raw pdf.js operator list, while a reference is held
//   2. what dropping the reference alone frees   (is _intentStates the holder?)
//   3. what page.cleanup() frees on top of that  (G20 / J3 C3)
//   4. the DERIVED VectorGeometry alone — the thing the cache would actually store
// Run with:  node --expose-gc mem-retention.mjs <pdf> [page] [maskDim] [scale]
import { readFileSync } from "node:fs";
import { loadPdfjs, loadEngine, loadCanvas, enginePath, densityFixture } from "./_paths.mjs";
const pdfjs = await loadPdfjs();
const oc = await loadEngine();

const file = process.argv[2], pageNo = Number(process.argv[3] ?? 1);
const maskDim = Number(process.argv[4] ?? 3000), scale = Number(process.argv[5] ?? 2);
const settle = async () => { for (let i = 0; i < 4; i++) { global.gc(); await new Promise((r) => setTimeout(r, 30)); } };
const M = () => { const u = process.memoryUsage(); return { h: u.heapUsed / 1048576, r: u.rss / 1048576, e: u.external / 1048576 }; };
const show = (label, a, b) => console.log(`${label.padEnd(46)} heapUsed=${b.h.toFixed(1)}MB (Δ${(b.h - a.h >= 0 ? "+" : "")}${(b.h - a.h).toFixed(1)})  rss=${b.r.toFixed(1)}MB  external=${b.e.toFixed(1)}MB`);

const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), isEvalSupported: false }).promise;
const page = await doc.getPage(pageNo);
const vp = page.getViewport({ scale });

await settle(); const base = M(); show("0 baseline (doc+page open)", base, base);

let opList = await page.getOperatorList();
await settle(); const afterOp = M(); show("1 + getOperatorList (ref held)", base, afterOp);

let geo = oc.extractVectorGeometry(opList, vp.transform, pdfjs.OPS);
await settle(); const afterGeo = M(); show("2 + extractVectorGeometry (both held)", base, afterGeo);

opList = null;
await settle(); const afterDrop = M(); show("3 drop opList ref (cleanup NOT called)", base, afterDrop);

const cleaned = page.cleanup();
await settle(); const afterClean = M(); show(`4 page.cleanup() -> ${cleaned}`, base, afterClean);

const mask = oc.buildMask(geo.segs, vp.width, vp.height, maskDim, geo.meta);
await settle(); const afterMask = M(); show("5 + buildMask (MaskObj held)", base, afterMask);

console.log(`\nsegs=${geo.segs.length >> 2}  points=${geo.points.length}  meta=${geo.meta.length}B  mask=${mask.mw}x${mask.mh}=${(mask.mask.length / 1048576).toFixed(1)}MB`);
console.log(`RETAINED PER PAGE, geometry only (step 4 − baseline) = ${(afterClean.h - base.h).toFixed(1)} MB heap`);
console.log(`RETAINED PER PAGE, geometry + mask (step 5 − baseline) = ${(afterMask.h - base.h).toFixed(1)} MB heap`);
console.log(`OP-LIST RETENTION freed by dropping the ref alone = ${(afterGeo.h - afterDrop.h).toFixed(1)} MB;  freed additionally by cleanup() = ${(afterDrop.h - afterClean.h).toFixed(1)} MB`);

// what a TYPED-ARRAY normalization of the same geometry would cost (the plan's
// "exact byteLength accounting" is only possible on typed arrays)
const segsF32 = Float32Array.from(geo.segs);
const segsF64 = Float64Array.from(geo.segs);
console.log(`\nif normalized: segs Float64Array=${(segsF64.byteLength / 1048576).toFixed(2)}MB  Float32Array=${(segsF32.byteLength / 1048576).toFixed(2)}MB  meta=${(geo.meta.byteLength / 1048576).toFixed(2)}MB`);
console.log(`points as JS Point[] has NO byteLength; as Float64Array it would be ${(geo.points.length * 2 * 8 / 1048576).toFixed(2)}MB`);
console.log(`geo.segs is a plain JS array? ${Array.isArray(geo.segs)}  geo.points? ${Array.isArray(geo.points)}  geo.segs.byteLength=${geo.segs.byteLength}`);
await doc.destroy();
